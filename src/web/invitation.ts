import QRCode from "qrcode";

export function mobileInvitationUrl(host: string, groupId: string, inviteCode?: string, port = 43128): string {
  return `http://${host}:${port}/#/join/${encodeURIComponent(groupId)}${inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : ""}`;
}

export function mobileInvitationQr(url: string): Promise<string> {
  return QRCode.toString(url, { type: "utf8", errorCorrectionLevel: "L", margin: 4 });
}
