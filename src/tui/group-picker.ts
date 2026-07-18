import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { NearbyGroup } from "../discovery/group-catalog.js";

export interface GroupPickerMembership {
  key: string;
  groupId: string;
  brokerId?: string;
  groupName: string;
  owner: boolean;
  updatedAt: number;
}

export type GroupPickerResult =
  | { type: "membership"; membershipKey: string; manage: boolean }
  | { type: "nearby"; group: NearbyGroup }
  | { type: "create" }
  | { type: "paste" }
  | { type: "local" }
  | { type: "cancel" };

interface PickerRow {
  key: string;
  label: string;
  description: string;
  result: Exclude<GroupPickerResult, { type: "cancel" }>;
}

export class GroupPicker implements Component, Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #done: (result: GroupPickerResult) => void;
  readonly #onRefresh: () => void;
  #memberships: GroupPickerMembership[];
  #nearby: NearbyGroup[] = [];
  #searching = true;
  #updateRequiredCount = 0;
  #selectedKey = "create";
  #focused = false;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    done: (result: GroupPickerResult) => void;
    memberships: GroupPickerMembership[];
    onRefresh: () => void;
  }) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#done = options.done;
    this.#memberships = options.memberships;
    this.#onRefresh = options.onRefresh;
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
  }

  setNearby(
    nearby: NearbyGroup[],
    options: { searching: boolean; updateRequiredCount?: number },
  ): void {
    this.#nearby = nearby;
    this.#searching = options.searching;
    this.#updateRequiredCount = options.updateRequiredCount ?? 0;
    const rows = this.#rows();
    if (!rows.some((row) => row.key === this.#selectedKey)) {
      this.#selectedKey = rows[0]?.key ?? "create";
    }
    this.#tui.requestRender();
  }

  handleInput(data: string): void {
    const rows = this.#rows();
    const selectedIndex = Math.max(
      0,
      rows.findIndex((row) => row.key === this.#selectedKey),
    );
    if (matchesKey(data, Key.up)) {
      this.#selectedKey = rows[Math.max(0, selectedIndex - 1)]?.key ??
        this.#selectedKey;
    } else if (matchesKey(data, Key.down)) {
      this.#selectedKey = rows[Math.min(rows.length - 1, selectedIndex + 1)]?.key ??
        this.#selectedKey;
    } else if (matchesKey(data, Key.return)) {
      const selected = rows[selectedIndex];
      if (selected !== undefined) this.#done(selected.result);
    } else if (matchesKey(data, Key.escape)) {
      this.#done({ type: "cancel" });
    } else if (data.toLocaleLowerCase("en-US") === "r") {
      this.#searching = true;
      this.#onRefresh();
    }
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    const owned = this.#sectionRows(true);
    const joined = this.#sectionRows(false);
    const nearby = this.#nearbyRows();
    const lines = [
      this.#theme.bold(this.#theme.fg("accent", "Pi Comms")),
      this.#theme.fg("muted", "选择一个群组，或创建新的群组"),
      "",
      ...this.#renderSection("我的群组", owned, "还没有自己创建的群组"),
      "",
      ...this.#renderSection("已加入", joined, "还没有加入其他群组"),
      "",
      this.#theme.bold("附近群组"),
      ...(nearby.length > 0
        ? nearby.map((row) => this.#renderRow(row))
        : [this.#theme.fg(
            "muted",
            this.#searching
              ? "  正在查找附近群组…"
              : "  附近暂时没有可加入的群组",
          )]),
      ...(this.#updateRequiredCount > 0
        ? [this.#theme.fg(
            "warning",
            `  发现 ${this.#updateRequiredCount} 台设备需要更新 Pi Comms`,
          )]
        : []),
      "",
      this.#theme.bold("其他操作"),
      ...this.#utilityRows().map((row) => this.#renderRow(row)),
      "",
      this.#theme.fg("dim", "↑↓ 选择 · Enter 打开 · R 重新查找 · Esc 返回"),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  #renderSection(
    title: string,
    rows: PickerRow[],
    empty: string,
  ): string[] {
    return [
      this.#theme.bold(title),
      ...(rows.length > 0
        ? rows.map((row) => this.#renderRow(row))
        : [this.#theme.fg("muted", `  ${empty}`)]),
    ];
  }

  #renderRow(row: PickerRow): string {
    const selected = row.key === this.#selectedKey;
    const marker = selected ? this.#theme.fg("accent", "›") : " ";
    const label = selected ? this.#theme.bold(row.label) : row.label;
    return `${marker} ${label}  ${this.#theme.fg("dim", row.description)}`;
  }

  #rows(): PickerRow[] {
    return [
      ...this.#sectionRows(true),
      ...this.#sectionRows(false),
      ...this.#nearbyRows(),
      ...this.#utilityRows(),
    ];
  }

  #sectionRows(owner: boolean): PickerRow[] {
    return this.#memberships
      .filter((membership) => membership.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((membership) => ({
        key: `membership:${membership.key}`,
        label: membership.groupName,
        description: owner ? "你是群主" : "已保存长期成员身份",
        result: {
          type: "membership",
          membershipKey: membership.key,
          manage: false,
        },
      }));
  }

  #nearbyRows(): PickerRow[] {
    const joined = new Set(this.#memberships.map((membership) =>
      `${membership.brokerId ?? "local"}:${membership.groupId}`
    ));
    return this.#nearby
      .filter((group) => !joined.has(`${group.brokerId}:${group.groupId}`))
      .map((group) => ({
        key: `nearby:${group.brokerId}:${group.groupId}`,
        label: group.groupName,
        description: `${group.onlineSessionCount} 人在线`,
        result: { type: "nearby", group },
      }));
  }

  #utilityRows(): PickerRow[] {
    return [
      {
        key: "create",
        label: "创建群组",
        description: "选择仅本机或允许附近设备加入",
        result: { type: "create" },
      },
      {
        key: "paste",
        label: "使用邀请信息加入",
        description: "粘贴后直接定位群组",
        result: { type: "paste" },
      },
      {
        key: "local",
        label: "查看这台电脑上的其他群组",
        description: "连接本机但不自动进入群组",
        result: { type: "local" },
      },
    ];
  }
}

export class RequiredChoice<T extends string> implements Component, Focusable {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #title: string;
  readonly #choices: Array<{ value: T; label: string; description: string }>;
  readonly #done: (value: T | undefined) => void;
  #selected = -1;
  #focused = false;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    title: string;
    choices: Array<{ value: T; label: string; description: string }>;
    done: (value: T | undefined) => void;
  }) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#title = options.title;
    this.#choices = options.choices;
    this.#done = options.done;
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.#selected = this.#selected <= 0
        ? this.#choices.length - 1
        : this.#selected - 1;
    } else if (matchesKey(data, Key.down)) {
      this.#selected = (this.#selected + 1) % this.#choices.length;
    } else if (matchesKey(data, Key.return) && this.#selected >= 0) {
      this.#done(this.#choices[this.#selected]?.value);
    } else if (matchesKey(data, Key.escape)) {
      this.#done(undefined);
    }
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    return [
      this.#theme.bold(this.#title),
      this.#theme.fg("muted", "请明确选择一项"),
      "",
      ...this.#choices.map((choice, index) => {
        const selected = index === this.#selected;
        return `${selected ? this.#theme.fg("accent", "›") : " "} ${
          selected ? this.#theme.bold(choice.label) : choice.label
        }  ${this.#theme.fg("dim", choice.description)}`;
      }),
      "",
      this.#theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 返回"),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}
