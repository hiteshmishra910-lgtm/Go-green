import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download } from 'lucide-react';

interface QrCodeCardProps {
  residentId: string;
  residentName: string;
  area: string;
}

export const QrCodeCard: React.FC<QrCodeCardProps> = ({
  residentId,
  residentName,
  area,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !residentId) return;
    setQrError(null);
    QRCode.toCanvas(
      canvas,
      residentId,
      {
        width: 216,
        margin: 2,
        color: {
          dark: '#14532d',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'M',
      },
      (err) => {
        if (err) {
          console.error('QR generation failed:', err);
          setQrError('Could not render QR code.');
        }
      }
    );
  }, [residentId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(residentId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = `${residentId}-ecoverify-pass.png`;
    link.click();
  };

  return (
    <div className="bg-white border border-emerald-950/10 rounded-2xl p-6 flex flex-col items-center text-center">
      <p className="text-xs font-medium text-emerald-800 tracking-wide mb-1">
        Verified Collection Pass
      </p>
      <h3 className="text-base font-bold text-slate-900 mb-1 truncate max-w-full">
        {residentName}
      </h3>
      <p className="text-xs text-slate-500 mb-4">{area || 'Assigned Municipal Zone'}</p>

      <div className="p-3 bg-white border border-emerald-950/10 rounded-xl mb-4">
        {qrError ? (
          <div className="w-[216px] h-[216px] flex items-center justify-center text-xs text-rose-600">
            {qrError}
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            aria-label={`QR code for resident ${residentId}`}
            className="block rounded-lg"
          />
        )}
      </div>

      <div className="w-full flex items-center justify-between gap-2 bg-[#f6faf7] border border-emerald-950/10 rounded-xl px-3.5 py-2.5 mb-4">
        <span className="font-mono text-sm font-semibold text-emerald-950 tabular-nums">
          {residentId}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 hover:text-emerald-950 px-2 py-1 rounded-lg hover:bg-emerald-100/70 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy ID'}
        </button>
      </div>

      <button
        type="button"
        onClick={handleDownload}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer"
      >
        <Download className="w-4 h-4" />
        Download QR Pass
      </button>
      <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
        Encodes only your unique Resident ID. Private address and contact details remain protected.
      </p>
    </div>
  );
};
