import { tx } from "../lib/i18n";
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** Generated locally from the already verified address. Four modules of quiet space on each side. */
export default function DepositQR({ address }: { address: string }) {
  const code = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(address, "Byte");
    qr.make();
    const count = qr.getModuleCount();
    const cells: string[] = [];
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`);
    return { size: count + 8, path: cells.join("") };
  }, [address]);
  return <svg className="deposit-qr" viewBox={`0 0 ${code.size} ${code.size}`} role="img" aria-label={tx("Deposit address QR code")} shapeRendering="crispEdges">
    <rect width={code.size} height={code.size} fill="white" /><path d={code.path} fill="#0a1638" />
  </svg>;
}
