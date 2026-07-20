import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrokerServer, type BrokerServer } from "../src/broker/server.js";
import { fetchGroupCatalog } from "../src/discovery/group-catalog.js";
import { BrokerClient } from "../src/extension/broker-client.js";
import type { BrokerEnvelope } from "../src/protocol.js";

class Session {
  readonly messages: BrokerEnvelope[] = [];
  readonly client: BrokerClient;

  constructor(
    endpoint: { host: string; port: number },
    deviceId: string,
  ) {
    this.client = new BrokerClient({
      endpoint,
      deviceId,
      reconnectIntervalMs: 20,
      onMessage: (message) => this.messages.push(message),
      onDisconnected() {},
    });
  }

  async start(sessionId: string): Promise<void> {
    expect(await this.client.start(sessionId)).toBe(true);
  }

  send(type: string, payload: unknown): void {
    expect(this.client.send(type, payload)).toBeDefined();
  }

  async waitFor(
    predicate: (message: BrokerEnvelope) => boolean,
  ): Promise<BrokerEnvelope> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const message = this.messages.find(predicate);
      if (message !== undefined) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待消息超时：${JSON.stringify(this.messages)}`);
  }
}

describe("每群邀请与长期成员", () => {
  let directory: string | undefined;
  let broker: BrokerServer | undefined;
  const sessions: Session[] = [];
  let local = true;

  beforeEach(() => {
    local = true;
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.client.stop()));
    sessions.length = 0;
    await broker?.close();
    broker = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  async function startBroker(): Promise<void> {
    directory = await mkdtemp(join(tmpdir(), "pi-comms-membership-"));
    broker = createBrokerServer({
      listen: { host: "127.0.0.1", port: 0 },
      dbPath: join(directory, "comms.db"),
      isLoopback: () => local,
      inviteFailureLimit: 2,
      inviteCooldownMs: 5_000,
    });
    await broker.start();
  }

  async function createNearbyGroup(): Promise<{
    owner: Session;
    groupId: string;
    inviteCode: string;
    ownerCredential: string;
  }> {
    const owner = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000201",
    );
    sessions.push(owner);
    await owner.start("owner-session");
    owner.send("group.create", {
      groupName: "分布式开发组",
      userName: "Alice",
      agentName: "Alice-Pi",
      visibility: "nearby",
      inviteRequired: true,
    });
    const welcome = await owner.waitFor(
      (message) => message.type === "membership.welcome",
    );
    if (
      welcome.type !== "membership.welcome" ||
      welcome.payload.inviteCode === undefined ||
      welcome.payload.ownerCredential === undefined
    ) throw new Error("群主未获得完整凭证");
    return {
      owner,
      groupId: welcome.payload.groupId,
      inviteCode: welcome.payload.inviteCode,
      ownerCredential: welcome.payload.ownerCredential,
    };
  }

  it("邀请码只在首次加入使用，长期凭证可在重连后恢复", async () => {
    await startBroker();
    const created = await createNearbyGroup();
    local = false;
    const bob = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000202",
    );
    sessions.push(bob);
    await bob.start("bob-session");
    bob.send("group.join", {
      groupId: created.groupId,
      userName: "Bob",
      agentName: "Bob-Pi",
      inviteCode: created.inviteCode,
    });
    const joined = await bob.waitFor(
      (message) => message.type === "membership.welcome",
    );
    if (joined.type !== "membership.welcome") throw new Error("未签发长期凭证");
    const credential = joined.payload.membershipCredential;
    await bob.client.stop();

    const restored = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000202",
    );
    sessions.push(restored);
    await restored.start("bob-session");
    restored.send("group.join", {
      groupId: created.groupId,
      membershipCredential: credential,
    });
    const snapshot = await restored.waitFor(
      (message) => message.type === "snapshot" &&
        message.payload.group?.groupId === created.groupId,
    );
    expect(snapshot.type === "snapshot" && snapshot.payload.members)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ displayName: "Bob" }),
        expect.objectContaining({ displayName: "Bob-Pi" }),
      ]));
  });

  it("创建时启用邀请码后，远程首次加入不能省略邀请码", async () => {
    await startBroker();
    const created = await createNearbyGroup();
    local = false;
    const member = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000219",
    );
    sessions.push(member);
    await member.start("missing-invite");
    member.send("group.join", {
      groupId: created.groupId,
      userName: "Bob",
      agentName: "Bob-Pi",
    });
    const error = await member.waitFor(
      (message) => message.type === "error" &&
        message.payload.code === "invite_required",
    );
    expect(error.type === "error" && error.payload.message)
      .toBe("请输入群组邀请码");
  });

  it("附近群组默认允许直接加入，创建时可明确要求邀请码", async () => {
    await startBroker();
    const owner = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000220",
    );
    sessions.push(owner);
    await owner.start("open-owner");
    owner.send("group.create", {
      groupName: "开放开发组",
      userName: "Alice",
      agentName: "Alice-Pi",
      visibility: "nearby",
    });
    const created = await owner.waitFor(
      (message) => message.type === "membership.welcome",
    );
    if (created.type !== "membership.welcome") throw new Error("群组创建失败");
    expect(created.payload.inviteCode).toBeUndefined();

    await expect(fetchGroupCatalog(broker!.endpoint, broker!.brokerId)).resolves
      .toEqual([
        expect.objectContaining({
          groupId: created.payload.groupId,
          inviteRequired: false,
        }),
      ]);

    local = false;
    const member = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000221",
    );
    sessions.push(member);
    await member.start("open-member");
    member.send("group.join", {
      groupId: created.payload.groupId,
      userName: "Bob",
      agentName: "Bob-Pi",
    });
    await expect(member.waitFor(
      (message) => message.type === "membership.welcome",
    )).resolves.toBeDefined();
  });

  it("轮换邀请码不影响已有成员，错误邀请码会进入冷却", async () => {
    await startBroker();
    const created = await createNearbyGroup();
    created.owner.send("group.invite.rotate", {
      groupId: created.groupId,
      ownerCredential: created.ownerCredential,
    });
    const rotated = await created.owner.waitFor(
      (message) => message.type === "group.invite.updated",
    );
    if (rotated.type !== "group.invite.updated" || rotated.payload.inviteCode === undefined) {
      throw new Error("未生成新邀请码");
    }
    expect(rotated.payload.inviteCode).not.toBe(created.inviteCode);

    local = false;
    const errors: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const session = new Session(
        broker!.endpoint,
        `00000000-0000-4000-8000-00000000021${index}`,
      );
      sessions.push(session);
      await session.start(`wrong-${index}`);
      session.send("group.join", {
        groupId: created.groupId,
        userName: `User${index}`,
        agentName: `Agent${index}`,
        inviteCode: "ZZZZZZZZZZ",
      });
      const error = await session.waitFor((message) => message.type === "error");
      if (error.type === "error") errors.push(error.payload.message);
    }
    expect(errors).toEqual([
      "邀请码不正确",
      "邀请码不正确",
      "尝试过多，请稍后再试",
    ]);
  });

  it("只读目录只返回允许附近加入的群组", async () => {
    await startBroker();
    const created = await createNearbyGroup();
    await expect(fetchGroupCatalog(broker!.endpoint, broker!.brokerId)).resolves.toEqual([
      expect.objectContaining({
        groupId: created.groupId,
        groupName: "分布式开发组",
        onlineSessionCount: 1,
      }),
    ]);
  });

  it("群主管理权绑定 Session，本机恢复会让旧凭证失效", async () => {
    await startBroker();
    const created = await createNearbyGroup();
    local = false;
    const bob = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000202",
    );
    sessions.push(bob);
    await bob.start("bob-session");
    bob.send("group.join", {
      groupId: created.groupId,
      userName: "Bob",
      agentName: "Bob-Pi",
      inviteCode: created.inviteCode,
    });
    const memberWelcome = await bob.waitFor(
      (message) => message.type === "membership.welcome",
    );
    if (memberWelcome.type !== "membership.welcome") {
      throw new Error("Bob 未获得长期成员凭证");
    }

    local = true;
    bob.send("group.owner.recover", {
      groupId: created.groupId,
      membershipCredential: memberWelcome.payload.membershipCredential,
    });
    const ownerWelcome = await bob.waitFor(
      (message) => message.type === "group.owner.welcome",
    );
    if (ownerWelcome.type !== "group.owner.welcome") {
      throw new Error("Bob 未恢复群主管理权");
    }

    created.owner.send("group.rename", {
      groupId: created.groupId,
      groupName: "旧凭证不能改名",
      ownerCredential: created.ownerCredential,
    });
    await expect(created.owner.waitFor(
      (message) => message.type === "error" &&
        message.payload.code === "owner_required",
    )).resolves.toBeDefined();

    bob.send("group.rename", {
      groupId: created.groupId,
      groupName: "新群主开发组",
      ownerCredential: ownerWelcome.payload.ownerCredential,
    });
    const renamed = await bob.waitFor(
      (message) => message.type === "snapshot" &&
        message.payload.group?.groupName === "新群主开发组",
    );
    expect(renamed.type === "snapshot" && renamed.payload.isOwner).toBe(true);
  });

  it("解散后离线成员收到一次通知并失去长期凭证", async () => {
    await startBroker();
    const created = await createNearbyGroup();
    local = false;
    const bob = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000202",
    );
    sessions.push(bob);
    await bob.start("bob-session");
    bob.send("group.join", {
      groupId: created.groupId,
      userName: "Bob",
      agentName: "Bob-Pi",
      inviteCode: created.inviteCode,
    });
    const welcome = await bob.waitFor(
      (message) => message.type === "membership.welcome",
    );
    if (welcome.type !== "membership.welcome") throw new Error("未获得成员凭证");
    await bob.client.stop();

    local = true;
    created.owner.send("group.delete", {
      groupId: created.groupId,
      ownerCredential: created.ownerCredential,
    });
    await created.owner.waitFor(
      (message) => message.type === "snapshot" &&
        message.payload.group === undefined,
    );

    local = false;
    const restored = new Session(
      broker!.endpoint,
      "00000000-0000-4000-8000-000000000202",
    );
    sessions.push(restored);
    await restored.start("bob-session");
    restored.send("group.join", {
      groupId: created.groupId,
      membershipCredential: welcome.payload.membershipCredential,
    });
    const deleted = await restored.waitFor(
      (message) => message.type === "error" &&
        message.payload.code === "group_deleted",
    );
    expect(deleted.type === "error" && deleted.payload.message)
      .toContain("分布式开发组");
  });
});
