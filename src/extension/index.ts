import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DATABASE_PATH,
} from "../broker/server.js";
import type {
  AgentRequestPayload,
  AgentResultAckPayload,
  AgentResultPayload,
  BrokerEnvelope,
  HistoryMessage,
  PausedChainPayload,
  SnapshotPayload,
  MembershipWelcomePayload,
} from "../protocol.js";
import type {
  AgentPermission,
  Group,
  GroupSettings,
  GroupSummary,
  Member,
} from "../types.js";
import {
  DEFAULT_BROKER_ENDPOINT,
  validateConnectEndpoint,
  type TcpConnectEndpoint,
} from "../transport/tcp-endpoint.js";
import { ChatView } from "../tui/chat-view.js";
import {
  GroupPicker,
  RequiredChoice,
  type GroupPickerMembership,
  type GroupPickerResult,
} from "../tui/group-picker.js";
import { BrokerClient } from "./broker-client.js";
import { startLanHostBroker, startLocalBroker } from "./broker-process.js";
import {
  CONNECTION_CONFIG_ENTRY,
  formatInvitation,
  getLanIPv4Addresses,
  hasLegacyRemoteConnection,
  parseInvitation,
  restoreConnectionConfig,
  type ConnectionConfig,
} from "./connection-config.js";
import { RemoteQueue } from "./remote-queue.js";
import { BrokerDiscovery } from "../discovery/mdns.js";
import { NearbyGroupsWatcher } from "../discovery/group-catalog.js";
import { primaryOrdinaryNetwork } from "../discovery/network.js";
import { NetworkAccessStore } from "../discovery/network-access.js";

const STATUS_KEY = "pi-comms";
const PERMISSION_ENTRY = "pi-comms-permission";
const MEMBERSHIP_ENTRY = "pi-comms-membership";
const MEMBERSHIP_REMOVED_ENTRY = "pi-comms-membership-removed";
const DEFAULT_NAMES_ENTRY = "pi-comms-default-names";
const DEFAULT_RESULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_BROKER_START_TIMEOUT_MS = 8_000;

interface SavedMembership {
  groupId: string;
  groupName?: string;
  membershipCredential: string;
  ownerCredential?: string;
  ownerSessionId?: string;
  userName: string;
  agentName: string;
  updatedAt: number;
  inviteCode?: string;
  connection?: Exclude<ConnectionConfig, { mode: "local" }> | { mode: "local" };
}

interface DesiredMembership {
  groupId: string;
  userName: string;
  agentName: string;
  inviteCode?: string;
  membershipCredential?: string;
}

export interface CommsExtensionOptions {
  endpoint?: TcpConnectEndpoint;
  reconnectIntervalMs?: number;
  resultRetryIntervalMs?: number;
  dbPath?: string;
  connectionConfig?: ConnectionConfig;
  startBroker?: (mode: "local" | "lan-host") => Promise<void> | void;
  registerTestCommands?: boolean;
}

export function createCommsExtension(
  options: CommsExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const endpoint = validateConnectEndpoint(options.endpoint ?? DEFAULT_BROKER_ENDPOINT);
  const resultRetryIntervalMs =
    options.resultRetryIntervalMs ?? DEFAULT_RESULT_RETRY_INTERVAL_MS;
  const dbPath = options.dbPath ?? DEFAULT_DATABASE_PATH;
  const startBroker = options.startBroker ?? ((mode) =>
    mode === "lan-host"
      ? startLanHostBroker(endpoint, dbPath)
      : startLocalBroker(endpoint, dbPath));

  return (pi: ExtensionAPI) => {
    const remoteQueue = new RemoteQueue();
    let context: ExtensionContext | undefined;
    let ui: ExtensionUIContext | undefined;
    let sessionId: string | undefined;
    let clientId: string | undefined;
    let brokerInstanceId: string | undefined;
    let currentGroup: Group | undefined;
    let currentGroupSettings: GroupSettings | undefined;
    let currentIsOwner = false;
    let desiredMembership: DesiredMembership | undefined;
    let savedMembership: SavedMembership | undefined;
    let savedMemberships = new Map<string, SavedMembership>();
    let history: HistoryMessage[] = [];
    let availableGroups: GroupSummary[] = [];
    let members = new Map<string, Member>();
    let lastAssistantText: string | undefined;
    let resultRetryTimer: ReturnType<typeof setInterval> | undefined;
    let shuttingDown = false;
    let commsOpen = false;
    let activeView: ChatView | undefined;
    let cachedUserName = "";
    let cachedAgentName = "";
    let pendingCreate:
      | {
          groupName: string;
          visibility: "local" | "nearby";
          inviteRequired: boolean;
        }
      | undefined;
    let openGroupManagement = false;
    let networkMonitorTimer: ReturnType<typeof setInterval> | undefined;
    let activeNetworkKey: string | undefined;
    let askingNetworkPermission = false;
    const networkAccessStore = new NetworkAccessStore(dbPath);
    let brokerStartTask: Promise<boolean> | undefined;
    let brokerStartError: string | undefined;
    let permission: AgentPermission = "auto";
    let connectionConfig = options.connectionConfig ??
      (options.registerTestCommands ? { mode: "local" as const } : undefined);
    let connectionConfigPersisted = options.connectionConfig !== undefined ||
      options.registerTestCommands === true;
    const pendingApprovals = new Map<string, AgentRequestPayload>();
    const pausedChains = new Map<string, PausedChainPayload>();

    const brokerClient = new BrokerClient({
      endpoint,
      reconnectIntervalMs: options.reconnectIntervalMs,
      onMessage: handleBrokerMessage,
      onDisconnected: (wasConnected) => {
        clientId = undefined;
        setConnected(false);
        if (!shuttingDown && commsOpen) {
          activeView?.setConnection("reconnecting");
          void connectOrStartBroker();
        }
      },
    });

    function updateContext(ctx: ExtensionContext): void {
      context = ctx;
      ui = ctx.ui;
      sessionId = ctx.sessionManager.getSessionId();
    }

    async function applyConnectionConfig(config: ConnectionConfig): Promise<void> {
      const target = config.mode === "lan-client" ? config.endpoint : endpoint;
      await brokerClient.setConnection({
        endpoint: target,
        ...(config.mode === "lan-client" ? {
          expectedBrokerId: config.brokerId,
        } : config.mode === "lan-host" && config.brokerId !== undefined ? {
          expectedBrokerId: config.brokerId,
        } : {}),
      });
    }

    function saveConnectionConfig(config: ConnectionConfig): void {
      connectionConfig = config;
      pi.appendEntry(
        CONNECTION_CONFIG_ENTRY,
        redactInvitation(config),
      );
    }

    async function chooseConnectionConfig(
      ctx: ExtensionContext,
    ): Promise<ConnectionConfig | undefined> {
      const memberships: GroupPickerMembership[] = [...savedMemberships.values()]
        .map((membership) => ({
          key: membershipKey(membership),
          groupId: membership.groupId,
          ...(membership.connection?.mode === "lan-client" &&
              membership.connection.brokerId !== undefined
            ? { brokerId: membership.connection.brokerId }
            : {}),
          groupName: membership.groupName ?? membership.groupId,
          owner: membership.ownerCredential !== undefined,
          updatedAt: membership.updatedAt,
        }));
      const discovery = new BrokerDiscovery({
        interfaceAddress: getLanIPv4Addresses()[0],
        onChanged() {},
      });
      let picker: GroupPicker | undefined;
      let emptyTimer: ReturnType<typeof setTimeout> | undefined;
      const watcher = new NearbyGroupsWatcher({
        discovery,
        onChanged: (catalog) => {
          if (catalog.groups.length > 0 || catalog.updateRequiredCount > 0) {
            if (emptyTimer !== undefined) clearTimeout(emptyTimer);
            picker?.setNearby(catalog.groups, {
              searching: false,
              updateRequiredCount: catalog.updateRequiredCount,
            });
          }
        },
      });
      emptyTimer = setTimeout(() => {
        picker?.setNearby([], { searching: false });
      }, 2_500);
      let picked: GroupPickerResult;
      try {
        picked = await ctx.ui.custom<GroupPickerResult>((tui, theme, _keybindings, done) => {
          picker = new GroupPicker({
            tui,
            theme,
            done,
            memberships,
            onRefresh: () => {
              picker?.setNearby([], { searching: true });
              discovery.refresh();
              void watcher.refresh();
            },
          });
          watcher.start();
          return picker;
        });
      } finally {
        if (emptyTimer !== undefined) clearTimeout(emptyTimer);
        watcher.stop();
      }
      if (picked.type === "cancel") return undefined;
      if (picked.type === "membership") {
        const stored = savedMemberships.get(picked.membershipKey);
        if (stored === undefined) return undefined;
        if (stored.ownerCredential !== undefined) {
          const action = await ctx.ui.select(stored.groupName ?? "我的群组", [
            "进入群聊",
            "群组管理",
          ]);
          if (action === undefined) return undefined;
          openGroupManagement = action === "群组管理";
        }
        savedMembership = stored;
        desiredMembership = {
          groupId: stored.groupId,
          userName: stored.userName,
          agentName: stored.agentName,
          membershipCredential: stored.membershipCredential,
        };
        return stored.connection ?? { mode: "local" };
      }
      if (picked.type === "local") return { mode: "local" };
      if (picked.type === "create") {
        const groupName = await ctx.ui.input("群组名称", "例如：项目协作");
        if (groupName === undefined || !groupName.trim()) return undefined;
        const range = await ctx.ui.custom<"nearby" | "local" | undefined>(
          (tui, theme, _keybindings, done) => new RequiredChoice({
            tui,
            theme,
            title: "谁可以使用这个群组？",
            done,
            choices: [
              {
                value: "nearby",
                label: "允许附近设备加入",
                description: "同一网络中的用户可以看到",
              },
              {
                value: "local",
                label: "仅这台电脑",
                description: "只供本机 Pi Session 使用",
              },
            ],
          }),
        );
        if (range === undefined) return undefined;
        const visibility = range;
        if (visibility === "nearby") {
          const network = primaryOrdinaryNetwork();
          if (network === undefined) {
            ctx.ui.notify("当前网络无法连接附近设备", "error");
            return undefined;
          }
          const confirmed = await ctx.ui.confirm(
            "允许附近设备看到这个群组？",
            "只会使用当前普通网络。VPN 打开或关闭不会改变这个设置。",
          );
          if (!confirmed) return undefined;
          await networkAccessStore.confirm(network);
          activeNetworkKey = network.networkKey;
        }
        const joinMode = visibility === "nearby"
          ? await ctx.ui.custom<"open" | "invite" | undefined>(
              (tui, theme, _keybindings, done) => new RequiredChoice({
                tui,
                theme,
                title: "其他人如何加入？",
                done,
                initialValue: "open",
                choices: [
                  {
                    value: "open",
                    label: "直接加入",
                    description: "默认；附近用户不需要邀请码",
                  },
                  {
                    value: "invite",
                    label: "使用邀请码",
                    description: "加入前需要输入这个群的邀请码",
                  },
                ],
              }),
            )
          : "open";
        if (joinMode === undefined) return undefined;
        if (!(await ensureDefaultNames(ctx))) return undefined;
        pendingCreate = {
          groupName: groupName.trim(),
          visibility,
          inviteRequired: joinMode === "invite",
        };
        return visibility === "nearby" ? { mode: "lan-host" } : { mode: "local" };
      }
      if (picked.type === "paste") {
        const invitation = await ctx.ui.input(
          "粘贴群组加入信息",
          "192.168.1.23:43127 群组ID [邀请码]",
        );
        if (invitation === undefined) return undefined;
        try {
          return { mode: "lan-client", ...parseInvitation(invitation) };
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return undefined;
        }
      }
      const target = picked.group;
      if (target.inviteRequired !== true) {
        return {
          mode: "lan-client",
          endpoint: target.endpoint,
          groupId: target.groupId,
          brokerId: target.brokerId,
        };
      }
      const inviteCode = await ctx.ui.input("输入这个群的邀请码", "ABCDE-FGHIJ");
      if (inviteCode === undefined) return undefined;
      try {
        const parsed = parseInvitation(
          `${target.endpoint.host}:${target.endpoint.port} ${target.groupId} ${inviteCode}`,
        );
        return {
          mode: "lan-client",
          ...parsed,
          brokerId: target.brokerId,
        };
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return undefined;
      }
    }

    async function ensureDefaultNames(ctx: ExtensionContext): Promise<boolean> {
      if (!cachedUserName) {
        const value = await ctx.ui.input("你的名称", "例如：Alice");
        if (value === undefined || !value.trim()) return false;
        cachedUserName = value.trim();
      }
      if (!cachedAgentName) {
        const value = await ctx.ui.input("你的 Agent 名称", `${cachedUserName}-Pi`);
        if (value === undefined || !value.trim()) return false;
        cachedAgentName = value.trim();
      }
      pi.appendEntry(DEFAULT_NAMES_ENTRY, {
        userName: cachedUserName,
        agentName: cachedAgentName,
      });
      return true;
    }

    function startNetworkMonitor(ctx: ExtensionContext): void {
      if (connectionConfig?.mode !== "lan-host" || networkMonitorTimer !== undefined) {
        return;
      }
      activeNetworkKey = primaryOrdinaryNetwork()?.networkKey;
      networkMonitorTimer = setInterval(() => {
        void refreshOrdinaryNetwork(ctx);
      }, 2_000);
      networkMonitorTimer.unref?.();
    }

    async function refreshOrdinaryNetwork(ctx: ExtensionContext): Promise<void> {
      const network = primaryOrdinaryNetwork();
      if (network?.networkKey === activeNetworkKey || askingNetworkPermission) return;
      activeNetworkKey = network?.networkKey;
      brokerClient.send("broker.network.refresh", {});
      if (network === undefined) {
        activeView?.setNetworkStatus("unavailable");
        return;
      }
      if (await networkAccessStore.isConfirmed(network)) {
        brokerClient.send("broker.network.refresh", {});
        activeView?.setNetworkStatus("available", network.interfaceName);
        return;
      }
      activeView?.setNetworkStatus("paused", network.interfaceName);
      askingNetworkPermission = true;
      try {
        const confirmed = await ctx.ui.confirm(
          "网络已改变",
          "是否允许当前网络中的附近设备看到你的群组？VPN 的开关不会触发这个提示。",
        );
        if (!confirmed) return;
        await networkAccessStore.confirm(network);
        brokerClient.send("broker.network.refresh", {});
        activeView?.setNetworkStatus("restoring", network.interfaceName);
      } finally {
        askingNetworkPermission = false;
      }
    }

    function setConnected(connected: boolean): void {
      activeView?.setConnection(connected ? "connected" : "reconnecting");
      if (activeView === undefined) {
        ui?.setStatus(
          STATUS_KEY,
          connected ? "群聊已连接" : "群聊暂时未连接",
        );
      }
    }

    function handleBrokerMessage(message: BrokerEnvelope): void {
      switch (message.type) {
        case "snapshot":
          handleSnapshot(message.payload);
          return;
        case "membership.welcome":
          saveMembership(message.payload);
          return;
        case "group.invite.updated": {
          if (savedMembership?.groupId === message.payload.groupId) {
            savedMembership = {
              ...savedMembership,
              ...(message.payload.inviteCode === undefined
                ? { inviteCode: undefined }
                : { inviteCode: message.payload.inviteCode }),
              updatedAt: Date.now(),
            };
            savedMemberships.set(membershipKey(savedMembership), savedMembership);
            pi.appendEntry(MEMBERSHIP_ENTRY, savedMembership);
          }
          if (
            message.payload.inviteRequired &&
            message.payload.inviteCode !== undefined
          ) {
            const address = getLanIPv4Addresses()[0];
            if (address !== undefined) {
              ui?.notify(
                `群组邀请：${formatInvitation(
                  { host: address, port: endpoint.port },
                  message.payload.groupId,
                  message.payload.inviteCode,
                )}`,
                "info",
              );
            }
          } else if (message.payload.visibility === "local") {
            ui?.notify("已停止附近加入", "info");
          } else {
            ui?.notify("附近用户现在可以直接加入", "info");
          }
          return;
        }
        case "group.owner.welcome":
          if (savedMembership?.groupId === message.payload.groupId) {
            savedMembership = {
              ...savedMembership,
              ownerCredential: message.payload.ownerCredential,
              ownerSessionId: sessionId,
              updatedAt: Date.now(),
            };
            savedMemberships.set(membershipKey(savedMembership), savedMembership);
            pi.appendEntry?.(MEMBERSHIP_ENTRY, savedMembership);
            ui?.notify("已恢复群主管理权，旧群主凭证已失效", "info");
          }
          return;
        case "broker.network.updated":
          activeView?.setNetworkStatus(
            message.payload.allowed ? "available" : "paused",
            message.payload.address,
          );
          return;
        case "groups.changed":
          availableGroups = message.payload.groups;
          activeView?.setGroups(availableGroups);
          return;
        case "presence.changed":
          if (message.payload.groupId === currentGroup?.groupId) {
            members.set(message.payload.memberId, message.payload);
            activeView?.updatePresence(message.payload);
          }
          return;
        case "presence.removed":
          for (const memberId of message.payload.memberIds) members.delete(memberId);
          activeView?.removeMembers(message.payload.memberIds);
          return;
        case "chat.message":
          if (
            message.payload.routeRequestId !== undefined &&
            message.payload.routeStatus !== "waiting_approval"
          ) {
            pendingApprovals.delete(message.payload.routeRequestId);
          }
          if (
            message.payload.requestId !== undefined &&
            message.payload.status !== "waiting_approval"
          ) {
            pendingApprovals.delete(message.payload.requestId);
          }
          activeView?.setPendingRequests([...pendingApprovals.values()]);
          {
            const receivedMessage: HistoryMessage = {
              ...message.payload,
              messageId: message.id,
              timestamp: message.timestamp,
            };
            const historyIndex = history.findIndex(
              (item) => item.messageId === receivedMessage.messageId,
            );
            if (historyIndex === -1) {
              history.push(receivedMessage);
            } else {
              history[historyIndex] = receivedMessage;
            }
            activeView?.receiveMessage(receivedMessage);
          }
          if (activeView === undefined) {
            ui?.notify(`[${message.payload.senderName}] ${message.payload.text}`, "info");
          }
          return;
        case "agent.deliver":
          handleAgentDelivery(message.payload);
          return;
        case "request.pending":
          pendingApprovals.set(message.payload.requestId, message.payload);
          activeView?.setPendingRequests([...pendingApprovals.values()]);
          return;
        case "chain.paused":
          pausedChains.set(message.payload.chainId, message.payload);
          activeView?.setPausedChains([...pausedChains.values()]);
          ui?.notify(
            `自动对话已达到第 ${message.payload.roundLimit} 轮，请在 Ctrl+P 中决定`,
            "warning",
          );
          return;
        case "chain.resolved":
          pausedChains.delete(message.payload.chainId);
          activeView?.setPausedChains([...pausedChains.values()]);
          activeView?.receiveChainResolved(message.payload);
          return;
        case "agent.result.ack":
          handleResultAck(message.payload);
          return;
        case "send.failed":
          pendingApprovals.delete(message.payload.requestId);
          activeView?.setPendingRequests([...pendingApprovals.values()]);
          activeView?.receiveFailure(message.payload);
          if (activeView === undefined) ui?.notify(`请求失败：${failureMessage(message.payload.reason)}`, "error");
          return;
        case "error":
          if (
            message.payload.code === "member_removed" ||
            message.payload.code === "membership_invalid" ||
            message.payload.code === "group_deleted"
          ) {
            clearSavedMembership();
          }
          activeView?.receiveError(message.payload);
          if (activeView === undefined) ui?.notify(message.payload.message, "error");
          return;
      }
    }

    function saveMembership(welcome: MembershipWelcomePayload): void {
      const own = desiredMembership;
      if (own === undefined) return;
      savedMembership = {
        groupId: welcome.groupId,
        membershipCredential: welcome.membershipCredential,
        ...(welcome.ownerCredential === undefined
          ? {}
          : {
              ownerCredential: welcome.ownerCredential,
              ownerSessionId: sessionId,
            }),
        ...(welcome.inviteCode === undefined
          ? {}
          : { inviteCode: welcome.inviteCode }),
        userName: own.userName,
        agentName: own.agentName,
        updatedAt: Date.now(),
        ...(connectionConfig === undefined
          ? {}
          : {
              connection: connectionConfig.mode === "lan-client"
                ? redactInvitation(connectionConfig)
                : connectionConfig,
            }),
      };
      savedMemberships.set(membershipKey(savedMembership), savedMembership);
      pi.appendEntry?.(MEMBERSHIP_ENTRY, savedMembership);
      if (welcome.ownerCredential !== undefined) {
        ui?.notify("群组已创建，可通过 Ctrl+G 管理附近加入和成员", "info");
      }
      desiredMembership = {
        groupId: welcome.groupId,
        membershipCredential: welcome.membershipCredential,
        userName: own.userName,
        agentName: own.agentName,
      };
      if (welcome.inviteCode !== undefined) {
        const address = getLanIPv4Addresses()[0];
        if (address !== undefined) {
          ui?.notify(
            `群组邀请：${formatInvitation(
              { host: address, port: endpoint.port },
              welcome.groupId,
              welcome.inviteCode,
            )}`,
            "info",
          );
        }
      }
    }

    function clearSavedMembership(): void {
      if (savedMembership !== undefined) {
        pi.appendEntry?.(MEMBERSHIP_REMOVED_ENTRY, {
          groupId: savedMembership.groupId,
          membershipKey: membershipKey(savedMembership),
          removedAt: Date.now(),
        });
      }
      if (savedMembership !== undefined) {
        savedMemberships.delete(membershipKey(savedMembership));
      }
      savedMembership = undefined;
      desiredMembership = undefined;
    }

    function handleSnapshot(snapshot: SnapshotPayload): void {
      const brokerRestarted =
        brokerInstanceId !== undefined &&
        brokerInstanceId !== snapshot.brokerInstanceId;
      if (brokerRestarted) {
        clearRemoteWork();
        if (activeView === undefined) {
          ui?.notify("群聊服务已重启，旧远程请求已中止，正在恢复群组", "warning");
        }
      }

      const previousGroupId = currentGroup?.groupId;
      brokerInstanceId = snapshot.brokerInstanceId;
      clientId = snapshot.clientId;
      availableGroups = snapshot.groups;
      currentGroup = snapshot.group;
      currentGroupSettings = snapshot.groupSettings;
      currentIsOwner = snapshot.isOwner === true;
      if (
        snapshot.group !== undefined &&
        savedMembership?.groupId === snapshot.group.groupId &&
        savedMembership.groupName !== snapshot.group.groupName
      ) {
        savedMembership = {
          ...savedMembership,
          groupName: snapshot.group.groupName,
          updatedAt: Date.now(),
        };
        savedMemberships.set(membershipKey(savedMembership), savedMembership);
        pi.appendEntry?.(MEMBERSHIP_ENTRY, savedMembership);
      }
      history = snapshot.messages;
      pausedChains.clear();
      for (const chain of snapshot.pausedChains ?? []) pausedChains.set(chain.chainId, chain);
      members = new Map(
        snapshot.members.map((member) => [member.memberId, member]),
      );
      activeView?.applySnapshot(snapshot);
      activeView?.setPausedChains([...pausedChains.values()]);
      if (snapshot.group !== undefined) {
        const ownMembers = snapshot.members.filter(
          (member) => member.clientId === snapshot.clientId,
        );
        const user = ownMembers.find((member) => member.type === "user");
        const agent = ownMembers.find((member) => member.type === "agent");
        if (user !== undefined && agent !== undefined) {
          desiredMembership = {
            groupId: snapshot.group.groupId,
            userName: user.displayName,
            agentName: agent.displayName,
            ...(savedMembership?.groupId === snapshot.group.groupId
              ? { membershipCredential: savedMembership.membershipCredential }
              : {}),
          };
        }
      }
      setConnected(true);
      if (
        snapshot.group !== undefined &&
        previousGroupId !== snapshot.group.groupId
      ) {
        if (activeView === undefined) {
          ui?.notify(
            `已加入群组：${snapshot.group.groupName}\nGroup ID: ${snapshot.group.groupId}`,
            "info",
          );
          if (history.length > 0) {
            ui?.notify(`已加载 ${history.length} 条历史消息`, "info");
          }
        }
      } else if (
        snapshot.group === undefined &&
        previousGroupId !== undefined &&
        !brokerRestarted
      ) {
        if (activeView === undefined) ui?.notify("已离开群组", "info");
        desiredMembership = undefined;
        history = [];
      } else if (previousGroupId === undefined && !brokerRestarted) {
        if (activeView === undefined) {
          ui?.notify("群聊已连接", "info");
        }
      }
      flushPendingResults();
      tryStartNext();
      if (snapshot.group === undefined && desiredMembership?.membershipCredential !== undefined) {
        brokerClient.send("group.join", desiredMembership);
      }
    }

    function handleAgentDelivery(request: AgentRequestPayload): void {
      pendingApprovals.delete(request.requestId);
      activeView?.setPendingRequests([...pendingApprovals.values()]);
      const added = remoteQueue.enqueue(request);
      brokerClient.send("agent.deliver.ack", {
        requestId: request.requestId,
      });
      if (added) {
        tryStartNext();
      }
    }

    function tryStartNext(): void {
      if (
        remoteQueue.activeRequest !== undefined ||
        context?.isIdle() !== true
      ) {
        publishAgentStatus();
        return;
      }
      const request = remoteQueue.startNext();
      if (request === undefined) {
        publishAgentStatus();
        return;
      }
      publishAgentStatus();
      activeView?.setOwnAgentBusy(true);
      lastAssistantText = undefined;
      try {
        pi.sendUserMessage(formatAgentRequest(request));
      } catch {
        completeActive({
          requestId: request.requestId,
          ok: false,
          reason: "delivery_failed",
        });
      }
    }

    function completeActive(result: AgentResultPayload): void {
      remoteQueue.completeActive(result);
      lastAssistantText = undefined;
      flushPendingResults();
      tryStartNext();
      publishAgentStatus();
    }

    function flushPendingResults(): void {
      for (const result of remoteQueue.pendingResults()) {
        brokerClient.send("agent.result", result);
      }
    }

    function handleResultAck(ack: AgentResultAckPayload): void {
      remoteQueue.acknowledgeResult(ack.requestId);
      if (!ack.accepted) {
        ui?.notify(`请求 ${ack.requestId} 已被群聊服务清理`, "warning");
      }
    }

    function clearRemoteWork(): void {
      if (remoteQueue.activeRequest !== undefined) {
        context?.abort();
      }
      remoteQueue.clear();
      lastAssistantText = undefined;
      activeView?.setOwnAgentBusy(false);
      publishAgentStatus();
    }

    function publishAgentStatus(): void {
      const busy = remoteQueue.hasWork || context?.isIdle() === false;
      brokerClient.send("agent.status", { status: busy ? "busy" : "idle" });
      activeView?.setOwnAgentBusy(busy);
    }

    async function connectOrStartBroker(): Promise<boolean> {
      if (brokerClient.connected) return true;
      if (brokerStartTask !== undefined) return brokerStartTask;
      brokerStartTask = (async () => {
        if (sessionId === undefined || connectionConfig === undefined) return false;
        if (connectionConfig.mode === "lan-host") {
          try {
            await startBroker("lan-host");
            brokerStartError = undefined;
          } catch (error) {
            brokerStartError = error instanceof Error ? error.message : String(error);
            return false;
          }
          return brokerClient.start(sessionId, permission);
        }
        if (await brokerClient.start(sessionId, permission)) return true;
        if (connectionConfig.mode === "lan-client") {
          return rediscoverSavedGroup();
        }
        try {
          await startBroker(connectionConfig.mode);
          brokerStartError = undefined;
        } catch (error) {
          brokerStartError = error instanceof Error ? error.message : String(error);
          return false;
        }
        const deadline = Date.now() + DEFAULT_BROKER_START_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
          if (await brokerClient.connect()) return true;
        }
        return false;
      })();
      try {
        return await brokerStartTask;
      } finally {
        brokerStartTask = undefined;
      }
    }

    async function rediscoverSavedGroup(): Promise<boolean> {
      if (
        sessionId === undefined ||
        connectionConfig?.mode !== "lan-client" ||
        connectionConfig.brokerId === undefined
      ) return false;
      const targetBrokerId = connectionConfig.brokerId;
      const targetGroupId = connectionConfig.groupId;
      const discovery = new BrokerDiscovery({
        interfaceAddress: getLanIPv4Addresses()[0],
        onChanged() {},
      });
      return new Promise<boolean>((resolveResult) => {
        let settled = false;
        const finish = (connected: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          watcher.stop();
          resolveResult(connected);
        };
        const watcher = new NearbyGroupsWatcher({
          discovery,
          onChanged: (catalog) => {
            const found = catalog.groups.find(
              (group) =>
                group.brokerId === targetBrokerId &&
                group.groupId === targetGroupId,
            );
            if (found === undefined) return;
            void (async () => {
              connectionConfig = {
                mode: "lan-client",
                endpoint: found.endpoint,
                groupId: targetGroupId,
                brokerId: targetBrokerId,
              };
              saveConnectionConfig(connectionConfig);
              if (savedMembership?.groupId === targetGroupId) {
                savedMembership = {
                  ...savedMembership,
                  connection: connectionConfig,
                  updatedAt: Date.now(),
                };
                savedMemberships.set(membershipKey(savedMembership), savedMembership);
                pi.appendEntry(MEMBERSHIP_ENTRY, savedMembership);
              }
              finish(await brokerClient.setConnection({
                endpoint: found.endpoint,
                expectedBrokerId: targetBrokerId,
              }));
            })();
          },
        });
        const timer = setTimeout(() => finish(false), 3_000);
        watcher.start();
      });
    }

    async function ensureConnected(ctx: ExtensionContext): Promise<boolean> {
      updateContext(ctx);
      if (connectionConfig === undefined) {
        connectionConfig = { mode: "local" };
        await applyConnectionConfig(connectionConfig);
      }
      if (await connectOrStartBroker()) {
        return true;
      }
      ctx.ui.notify(
        brokerStartError ?? brokerClient.lastError ?? "无法打开群聊",
        "error",
      );
      return false;
    }

    pi.on("session_start", (_event, ctx) => {
      shuttingDown = false;
      updateContext(ctx);
      permission = restorePermission(ctx);
      savedMemberships = restoreMemberships(ctx);
      const names = restoreDefaultNames(ctx);
      cachedUserName = names.userName;
      cachedAgentName = names.agentName;
      savedMembership = [...savedMemberships.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (savedMembership !== undefined) {
        desiredMembership = {
          groupId: savedMembership.groupId,
          userName: savedMembership.userName,
          agentName: savedMembership.agentName,
          membershipCredential: savedMembership.membershipCredential,
        };
      }
      brokerClient.setPermission(permission);
      if (options.connectionConfig === undefined && !options.registerTestCommands) {
        const branch = ctx.sessionManager.getBranch();
        if (hasLegacyRemoteConnection(branch)) {
          ctx.ui.notify(
            "邀请方式已升级，请向群主获取新的群组邀请",
            "warning",
          );
        }
        connectionConfig = restoreConnectionConfig(branch);
        connectionConfigPersisted = connectionConfig !== undefined;
      }
      if (connectionConfig !== undefined) void applyConnectionConfig(connectionConfig);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      shuttingDown = true;
      updateContext(ctx);
      if (resultRetryTimer !== undefined) {
        clearInterval(resultRetryTimer);
        resultRetryTimer = undefined;
      }
      if (networkMonitorTimer !== undefined) {
        clearInterval(networkMonitorTimer);
        networkMonitorTimer = undefined;
      }
      clearRemoteWork();
      await brokerClient.stop();
      clientId = undefined;
      currentGroup = undefined;
      desiredMembership = undefined;
      history = [];
      availableGroups = [];
      members.clear();
      pendingApprovals.clear();
      pausedChains.clear();
      commsOpen = false;
      activeView = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.on("input", (event, ctx) => {
      updateContext(ctx);
      if (
        remoteQueue.activeRequest !== undefined &&
        event.source !== "extension"
      ) {
        ctx.ui.notify("正在处理远程请求，请稍后", "warning");
        return { action: "handled" as const };
      }
      return { action: "continue" as const };
    });

    pi.on("message_end", (event, ctx) => {
      updateContext(ctx);
      if (
        remoteQueue.activeRequest !== undefined &&
        event.message.role === "assistant"
      ) {
        lastAssistantText = extractAssistantText(event.message.content);
      }
    });

    pi.on("agent_start", (_event, ctx) => {
      updateContext(ctx);
      publishAgentStatus();
    });

    pi.on("agent_settled", (_event, ctx) => {
      updateContext(ctx);
      const activeRequest = remoteQueue.activeRequest;
      if (activeRequest === undefined) {
        tryStartNext();
        return;
      }
      completeActive(
        lastAssistantText === undefined
          ? {
              requestId: activeRequest.requestId,
              ok: false,
              reason: "no_text",
            }
          : {
              requestId: activeRequest.requestId,
              ok: true,
              text: lastAssistantText,
            },
      );
      publishAgentStatus();
    });

    pi.registerCommand("comms", {
      description: "打开 Pi Comms 群聊",
      handler: async (_args, ctx) => {
        updateContext(ctx);
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/comms 只能在 Pi 交互式 TUI 中使用", "error");
          return;
        }
        if (commsOpen) return;
        if (
          options.connectionConfig === undefined &&
          !options.registerTestCommands
        ) {
          const selected = await chooseConnectionConfig(ctx);
          if (selected === undefined) return;
          connectionConfig = selected;
          connectionConfigPersisted = false;
          await applyConnectionConfig(selected);
        } else if (connectionConfig === undefined) {
          connectionConfig = { mode: "local" };
          await applyConnectionConfig(connectionConfig);
        }
        commsOpen = true;
        shuttingDown = false;
        resultRetryTimer ??= setInterval(flushPendingResults, resultRetryIntervalMs);

        let connected = await connectOrStartBroker();
        const canWaitOffline =
          savedMembership !== undefined &&
          connectionConfig.mode === "lan-client" &&
          savedMembership.groupId === connectionConfig.groupId &&
          savedMembership.membershipCredential.length > 0;
        while (
          !connected &&
          connectionConfig.mode === "lan-client" &&
          !canWaitOffline
        ) {
          ctx.ui.notify(
            `${brokerClient.lastError ?? "无法连接群组"}\n` +
            "当前网络或 VPN 可能禁止附近设备互访，请检查“允许局域网访问”。",
            "error",
          );
          await brokerClient.stop();
          const action = await ctx.ui.select("未能加入群组", [
            "重试",
            "修改邀请信息",
            "返回",
          ]);
          if (action === undefined || action === "返回") break;
          if (action === "修改邀请信息") {
            const invitation = await ctx.ui.input(
              "粘贴邀请信息",
              "192.168.1.23:43127 群组ID ABCDE-FGHIJ",
            );
            if (invitation === undefined) break;
            try {
              connectionConfig = { mode: "lan-client", ...parseInvitation(invitation) };
              connectionConfigPersisted = false;
              await applyConnectionConfig(connectionConfig);
            } catch (error) {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
              continue;
            }
          }
          connected = await connectOrStartBroker();
        }
        if (!connected && !canWaitOffline) {
          if (connectionConfig.mode !== "lan-client") {
            ctx.ui.notify(
              brokerStartError ?? brokerClient.lastError ?? "无法连接群组",
              "error",
            );
          }
          await brokerClient.stop();
          commsOpen = false;
          if (resultRetryTimer !== undefined) {
            clearInterval(resultRetryTimer);
            resultRetryTimer = undefined;
          }
          return;
        }
        const connectedBrokerId = brokerClient.brokerId;
        if (connectedBrokerId !== undefined && connectionConfig.mode !== "local") {
          connectionConfig = { ...connectionConfig, brokerId: connectedBrokerId };
          connectionConfigPersisted = false;
        }
        if (!connectionConfigPersisted) {
          saveConnectionConfig(connectionConfig);
          connectionConfigPersisted = true;
        }
        if (
          connected &&
          connectionConfig.mode === "lan-client" &&
          savedMembership?.groupId !== connectionConfig.groupId
        ) {
          desiredMembership = {
            groupId: connectionConfig.groupId,
            userName: cachedUserName,
            agentName: cachedAgentName,
            inviteCode: connectionConfig.inviteCode,
          };
        }
        if (connected && pendingCreate !== undefined) {
          while (availableGroups.some(
            (group) =>
              group.groupName.toLocaleLowerCase("en-US") ===
              pendingCreate!.groupName.toLocaleLowerCase("en-US"),
          )) {
            const replacement = await ctx.ui.input(
              "这个名称已经被使用",
              "请输入新的群组名称",
            );
            if (replacement === undefined || !replacement.trim()) {
              pendingCreate = undefined;
              break;
            }
            pendingCreate = {
              ...pendingCreate,
              groupName: replacement.trim(),
            };
          }
        }
        if (connected && pendingCreate !== undefined) {
          desiredMembership = {
            groupId: "",
            userName: cachedUserName,
            agentName: cachedAgentName,
          };
          brokerClient.send("group.create", {
            groupName: pendingCreate.groupName,
            userName: cachedUserName,
            agentName: cachedAgentName,
            visibility: pendingCreate.visibility,
            inviteRequired: pendingCreate.inviteRequired,
          });
          pendingCreate = undefined;
        }
        startNetworkMonitor(ctx);
        try {
          await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            const view = new ChatView({
              tui,
              theme,
              keybindings,
              done,
              initialUserName: cachedUserName,
              initialAgentName: cachedAgentName,
              initialPermission: permission,
              initialPendingRequests: [...pendingApprovals.values()],
              initialPausedChains: [...pausedChains.values()],
              ...(canWaitOffline
                ? { initialGroupName: savedMembership?.groupName ?? savedMembership?.groupId }
                : {}),
              openGroupPanelOnJoin: openGroupManagement,
              actions: {
                createGroup: (groupName, userName, agentName) => {
                  desiredMembership = { groupId: "", userName, agentName };
                  return brokerClient.send("group.create", {
                    groupName,
                    userName,
                    agentName,
                    visibility: connectionConfig?.mode === "lan-host"
                      ? "nearby"
                      : "local",
                  });
                },
                joinGroup: (groupId, userName, agentName, enteredInviteCode) => {
                  const restored = savedMembership?.groupId === groupId
                    ? savedMembership.membershipCredential
                    : undefined;
                  const inviteCode = enteredInviteCode ??
                    (connectionConfig?.mode === "lan-client" &&
                      connectionConfig.groupId === groupId
                    ? connectionConfig.inviteCode
                    : undefined);
                  desiredMembership = {
                    groupId,
                    userName,
                    agentName,
                    ...(restored === undefined
                      ? { inviteCode }
                      : { membershipCredential: restored }),
                  };
                  return brokerClient.send("group.join", desiredMembership);
                },
                sendMessage: (text) => brokerClient.send("chat.send", { text }),
                updatePermission: (nextPermission) => {
                  permission = nextPermission;
                  brokerClient.setPermission(nextPermission);
                  pi.appendEntry(PERMISSION_ENTRY, { permission: nextPermission });
                  return brokerClient.send("permission.update", {
                    permission: nextPermission,
                  }) !== undefined;
                },
                approveRequest: (requestId) => {
                  return brokerClient.send("request.approve", { requestId });
                },
                rejectRequest: (requestId) => {
                  return brokerClient.send("request.reject", { requestId });
                },
                continueChain: (chainId) => {
                  return brokerClient.send("chain.continue", { chainId });
                },
                endChain: (chainId) => {
                  return brokerClient.send("chain.end", { chainId });
                },
                updateGroupVisibility: (visibility) => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.visibility.update", {
                    groupId: currentGroup.groupId,
                    visibility,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                renameGroup: (groupName) => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.rename", {
                    groupId: currentGroup.groupId,
                    groupName,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                rotateGroupInvite: () => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.invite.rotate", {
                    groupId: currentGroup.groupId,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                showGroupInvitation: () => {
                  const address = getLanIPv4Addresses()[0];
                  if (
                    address === undefined ||
                    currentGroup === undefined
                  ) {
                    ctx.ui.notify(
                      "当前没有可分享的局域网地址",
                      "warning",
                    );
                    return;
                  }
                  ctx.ui.notify(
                    `群组加入信息：${formatInvitation(
                      { host: address, port: endpoint.port },
                      currentGroup.groupId,
                      savedMembership?.inviteCode,
                    )}`,
                    "info",
                  );
                },
                confirmAutostart: () => ctx.ui.confirm(
                  "开启登录后自动开放？",
                  "这会修改当前用户的后台启动配置，不需要管理员密码。",
                ),
                confirmNearbyAccess: async () => {
                  const network = primaryOrdinaryNetwork();
                  if (network === undefined) {
                    ctx.ui.notify("当前网络无法连接附近设备", "error");
                    return false;
                  }
                  if (!await networkAccessStore.isConfirmed(network)) {
                    const confirmed = await ctx.ui.confirm(
                      "允许附近设备看到这个群组？",
                      "只会使用当前普通网络。VPN 打开或关闭不会改变这个设置。",
                    );
                    if (!confirmed) return false;
                    await networkAccessStore.confirm(network);
                  }
                  activeNetworkKey = network.networkKey;
                  if (connectionConfig?.mode === "local") {
                    await brokerClient.stop();
                    await startBroker("lan-host");
                    connectionConfig = { mode: "lan-host" };
                    saveConnectionConfig(connectionConfig);
                    if (savedMembership !== undefined) {
                      savedMembership = {
                        ...savedMembership,
                        connection: connectionConfig,
                        updatedAt: Date.now(),
                      };
                      savedMemberships.set(membershipKey(savedMembership), savedMembership);
                      pi.appendEntry(MEMBERSHIP_ENTRY, savedMembership);
                    }
                    await applyConnectionConfig(connectionConfig);
                    if (sessionId === undefined ||
                      !await brokerClient.start(sessionId, permission)) {
                      ctx.ui.notify("正在重新开放群组，请稍后重试", "warning");
                      return false;
                    }
                    startNetworkMonitor(ctx);
                  }
                  brokerClient.send("broker.network.refresh", {});
                  return true;
                },
                updateGroupAvailability: (
                  keepAvailableWhenEmpty,
                  openAtLogin,
                ) => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.availability.update", {
                    groupId: currentGroup.groupId,
                    keepAvailableWhenEmpty,
                    openAtLogin,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                deleteGroup: () => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.delete", {
                    groupId: currentGroup.groupId,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                leaveGroup: () => {
                  clearRemoteWork();
                  const id = brokerClient.send("group.leave", {});
                  if (id !== undefined) clearSavedMembership();
                  return id;
                },
                removeMember: (stableSessionKey) => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.member.remove", {
                    groupId: currentGroup.groupId,
                    sessionKey: stableSessionKey,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                allowMember: (stableSessionKey) => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.ownerCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.member.allow", {
                    groupId: currentGroup.groupId,
                    sessionKey: stableSessionKey,
                    ownerCredential: savedMembership.ownerCredential,
                  });
                },
                recoverOwner: () => {
                  if (
                    currentGroup === undefined ||
                    savedMembership?.membershipCredential === undefined
                  ) return undefined;
                  return brokerClient.send("group.owner.recover", {
                    groupId: currentGroup.groupId,
                    membershipCredential: savedMembership.membershipCredential,
                  });
                },
                close: clearRemoteWork,
              },
            });
            activeView = view;
            ctx.ui.setStatus(STATUS_KEY, undefined);
            view.setGroups(availableGroups);
            view.setConnection(brokerClient.connected ? "connected" : "connecting");
            if (currentGroup !== undefined && clientId !== undefined) {
              view.applySnapshot({
                brokerInstanceId: brokerInstanceId ?? "",
                clientId,
                groups: availableGroups,
                group: currentGroup,
                members: [...members.values()],
                messages: history,
                pausedChains: [...pausedChains.values()],
                ...(currentGroupSettings === undefined
                  ? {}
                  : { groupSettings: currentGroupSettings }),
                isOwner: currentIsOwner,
                ownerRecoveryAvailable:
                  currentGroupSettings !== undefined && !currentIsOwner &&
                  connectionConfig?.mode !== "lan-client",
              });
            }
            return view;
          });
        } finally {
          const remainingOnline = [...members.values()].filter(
            (member) =>
              member.type === "user" &&
              member.online &&
              member.clientId !== clientId,
          ).length;
          if (currentIsOwner && remainingOnline > 0) {
            ctx.ui.notify(
              `你已离线，群组内还有 ${remainingOnline} 人在线`,
              "info",
            );
          }
          if (activeView !== undefined) {
            cachedUserName = activeView.userName;
            cachedAgentName = activeView.agentName;
          }
          activeView = undefined;
          openGroupManagement = false;
          pendingCreate = undefined;
          commsOpen = false;
          clearRemoteWork();
          desiredMembership = undefined;
          await brokerClient.stop();
          clientId = undefined;
          currentGroup = undefined;
          history = [];
          members.clear();
          pendingApprovals.clear();
          pausedChains.clear();
          if (resultRetryTimer !== undefined) {
            clearInterval(resultRetryTimer);
            resultRetryTimer = undefined;
          }
          if (networkMonitorTimer !== undefined) {
            clearInterval(networkMonitorTimer);
            networkMonitorTimer = undefined;
          }
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
      },
    });

    if (options.registerTestCommands) {
      registerTestCommands(pi, ensureConnected, brokerClient, () => ({
        currentGroup,
        availableGroups,
        members,
      }), (membership) => {
        desiredMembership = membership;
      }, clearRemoteWork);
    }
  };
}

export function formatAgentRequest(request: AgentRequestPayload): string {
  const online = request.onlineMembers.length
    ? request.onlineMembers
        .map(
          (member) =>
            `${member.displayName}(${member.type === "user" ? "用户" : "Agent"})`,
        )
        .join("、")
    : "无其他在线成员";
  return [
    "[Pi Comms 群聊请求]",
    `你是：${request.targetAgentName}（Agent）`,
    `所属用户：${request.ownerUserName}`,
    `来自：${request.senderName}${request.senderType === "agent" ? "（Agent）" : "（用户）"}`,
    ...(request.senderType === "agent" && request.senderOwnerUserName
      ? [`${request.senderName} 所属用户：${request.senderOwnerUserName}`]
      : []),
    `群组：${request.groupName}`,
    `在线：${online}`,
    ...(request.round > 1 ? [`这是第 ${request.round} 轮自动对话。`] : []),
    "",
    request.text,
    "",
    `你的回答会作为公开消息发送到群组「${request.groupName}」，用于回应 ${request.senderName}。请直接回答。`,
    `如果这个问题更适合群里其他在线 Agent 处理，可在回答开头 @Agent名称 并附上要转交的问题，任务会转给该 Agent；每次只转一次。`,
  ].join("\n");
}

function restorePermission(ctx: ExtensionContext): AgentPermission {
  let permission: AgentPermission = "auto";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === PERMISSION_ENTRY &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "permission" in entry.data &&
      isAgentPermission(entry.data.permission)
    ) {
      permission = entry.data.permission;
    }
  }
  return permission;
}

export function restoreMemberships(
  ctx: ExtensionContext,
): Map<string, SavedMembership> {
  const memberships = new Map<string, SavedMembership>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === MEMBERSHIP_REMOVED_ENTRY &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "groupId" in entry.data &&
      typeof entry.data.groupId === "string"
    ) {
      if (
        "membershipKey" in entry.data &&
        typeof entry.data.membershipKey === "string"
      ) {
        memberships.delete(entry.data.membershipKey);
      } else {
        for (const [key, membership] of memberships) {
          if (membership.groupId === entry.data.groupId) memberships.delete(key);
        }
      }
      continue;
    }
    if (
      entry.type !== "custom" ||
      entry.customType !== MEMBERSHIP_ENTRY ||
      typeof entry.data !== "object" ||
      entry.data === null
    ) continue;
    const value = entry.data as Partial<SavedMembership>;
    if (
      typeof value.groupId === "string" &&
      typeof value.membershipCredential === "string" &&
      typeof value.userName === "string" &&
      typeof value.agentName === "string" &&
      typeof value.updatedAt === "number"
    ) {
      const connection = parseSavedConnection(value.connection);
      const membership: SavedMembership = {
        groupId: value.groupId,
        ...(typeof value.groupName === "string" ? { groupName: value.groupName } : {}),
        membershipCredential: value.membershipCredential,
        ...(typeof value.ownerCredential === "string"
            && value.ownerSessionId === ctx.sessionManager.getSessionId()
          ? {
              ownerCredential: value.ownerCredential,
              ownerSessionId: value.ownerSessionId,
            }
          : {}),
        userName: value.userName,
        agentName: value.agentName,
        updatedAt: value.updatedAt,
        ...(typeof value.inviteCode === "string"
          ? { inviteCode: value.inviteCode }
          : {}),
        ...(connection === undefined ? {} : { connection }),
      };
      memberships.set(membershipKey(membership), membership);
    }
  }
  return memberships;
}

function membershipKey(membership: Pick<SavedMembership, "groupId" | "connection">): string {
  if (membership.connection?.mode === "lan-client") {
    const broker = membership.connection.brokerId ??
      `${membership.connection.endpoint.host}:${membership.connection.endpoint.port}`;
    return `${broker}:${membership.groupId}`;
  }
  return `local:${membership.groupId}`;
}

function restoreDefaultNames(
  ctx: ExtensionContext,
): { userName: string; agentName: string } {
  let names = { userName: "", agentName: "" };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== DEFAULT_NAMES_ENTRY ||
      typeof entry.data !== "object" ||
      entry.data === null
    ) continue;
    const value = entry.data as { userName?: unknown; agentName?: unknown };
    if (typeof value.userName === "string" && typeof value.agentName === "string") {
      names = { userName: value.userName, agentName: value.agentName };
    }
  }
  return names;
}

function parseSavedConnection(value: unknown): ConnectionConfig | undefined {
  if (typeof value !== "object" || value === null || !("mode" in value)) {
    return undefined;
  }
  if (value.mode === "local") return { mode: "local" };
  if (value.mode === "lan-host") {
    return {
      mode: "lan-host",
      ...("brokerId" in value && typeof value.brokerId === "string"
        ? { brokerId: value.brokerId }
        : {}),
    };
  }
  if (
    value.mode !== "lan-client" ||
    !("endpoint" in value) ||
    !("groupId" in value) ||
    typeof value.groupId !== "string"
  ) return undefined;
  try {
    return {
      mode: "lan-client",
      endpoint: validateConnectEndpoint(value.endpoint as TcpConnectEndpoint),
      groupId: value.groupId,
      ...("brokerId" in value && typeof value.brokerId === "string"
        ? { brokerId: value.brokerId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function redactInvitation(
  config: Extract<ConnectionConfig, { mode: "lan-client" }>,
): Extract<ConnectionConfig, { mode: "lan-client" }>;
function redactInvitation(config: ConnectionConfig): ConnectionConfig;
function redactInvitation(config: ConnectionConfig): ConnectionConfig {
  if (config.mode !== "lan-client") return config;
  const { inviteCode: _inviteCode, ...safe } = config;
  return safe;
}

function isAgentPermission(value: unknown): value is AgentPermission {
  return value === "auto" || value === "approval" || value === "blocked";
}

function registerTestCommands(
  pi: ExtensionAPI,
  ensureConnected: (ctx: ExtensionContext) => Promise<boolean>,
  brokerClient: BrokerClient,
  getState: () => {
    currentGroup: Group | undefined;
    availableGroups: GroupSummary[];
    members: Map<string, Member>;
  },
  setDesiredMembership: (
    membership: { groupId: string; userName: string; agentName: string },
  ) => void,
  clearRemoteWork: () => void,
): void {
  pi.registerCommand("comms-create", {
    description: "测试：创建群组",
    handler: async (args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      const values = parseCommandArgs(args, 3);
      if (values === undefined) return;
      setDesiredMembership({
        groupId: "",
        userName: values[1],
        agentName: values[2],
      });
      brokerClient.send("group.create", {
        groupName: values[0],
        userName: values[1],
        agentName: values[2],
      });
    },
  });
  pi.registerCommand("comms-join", {
    description: "测试：加入群组",
    handler: async (args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      const values = parseCommandArgs(args, 3);
      if (values === undefined) return;
      setDesiredMembership({ groupId: values[0], userName: values[1], agentName: values[2] });
      brokerClient.send("group.join", {
        groupId: values[0],
        userName: values[1],
        agentName: values[2],
      });
    },
  });
  pi.registerCommand("comms-members", {
    description: "测试：显示成员",
    handler: async (_args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      const state = getState();
      if (state.currentGroup === undefined) {
        ctx.ui.notify(
          state.availableGroups.length
            ? state.availableGroups.map((group) => `${group.groupName} ${group.onlineSessionCount} 人在线`).join("\n")
            : "暂无群组",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `群组：${state.currentGroup.groupName}\n${[...state.members.values()]
          .map((member) => `${member.displayName} (${member.type === "user" ? "用户" : "Agent"})`)
          .join("\n")}`,
        "info",
      );
    },
  });
  pi.registerCommand("comms-leave", {
    description: "测试：离开群组",
    handler: async (_args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      clearRemoteWork();
      brokerClient.send("group.leave", {});
    },
  });
  pi.registerCommand("comms-test", {
    description: "测试：发送消息",
    handler: async (args, ctx) => {
      if (!(await ensureConnected(ctx))) return;
      if (getState().currentGroup === undefined) {
        ctx.ui.notify("请先创建或加入群组", "error");
        return;
      }
      brokerClient.send("chat.send", { text: args.trim() || "测试消息" });
    },
  });
}

function parseCommandArgs(args: string, count: number): string[] | undefined {
  const values = args.trim().split(/\s+/).filter(Boolean);
  return values.length === count ? values : undefined;
}

function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content.trim()
      ? content.trim()
      : undefined;
  }
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("")
    .trim();
  return text || undefined;
}

function failureMessage(reason: string): string {
  switch (reason) {
    case "target_not_found":
      return "当前群组中找不到目标";
    case "target_offline":
    case "target_disconnected":
      return "目标 Agent 不在线";
    case "target_blocked":
      return "目标 Agent 已禁止接收";
    case "request_rejected":
      return "目标 Agent 主人已拒绝";
    case "request_invalid":
      return "请求已失效";
    case "agent_busy":
      return "目标 Agent 正忙";
    case "no_text":
      return "Agent 未产生文本回答";
    case "delivery_failed":
      return "请求无法注入目标 Agent";
    default:
      return "未知错误";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default createCommsExtension();
