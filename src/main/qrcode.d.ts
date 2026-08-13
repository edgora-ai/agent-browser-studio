// Minimal ambient types for the CommonJS "qrcode" package (no bundled types).
declare module "qrcode" {
  interface QRCodeOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: { dark?: string; light?: string };
  }
  const QRCode: {
    toDataURL(text: string, options?: QRCodeOptions): Promise<string>;
  };
  export default QRCode;
}
