import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  collection,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  AlertTriangle,
  Award,
  Camera,
  CheckCircle2,
  ClipboardList,
  Clock,
  History,
  ImagePlus,
  Loader2,
  MapPin,
  QrCode,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Search,
  UserCheck,
  UserX,
  X,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AiClassificationError,
  classifyWasteImage,
  formatTimestamp,
  lookupResidentByQrOrId,
  submitVerifiedCollection,
  toDate,
} from '../lib/ecoService';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  type AiClassificationFailureDetails,
  type AiWastePrediction,
  type AppSettings,
  DEFAULT_POINTS_BY_CATEGORY,
  type ResidentCard,
  type UserProfile,
  WASTE_CATEGORIES,
  type WasteCategory,
  type WasteCollectionRecord,
} from '../types/ecoverify';

type CollectorTab = 'scanner' | 'pending' | 'history';

interface CollectorDashboardProps {
  profile: UserProfile;
  settings: AppSettings | null;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

async function compressImageToJpegBase64(
  source: HTMLImageElement | HTMLVideoElement,
  maxDim = 896
): Promise<{ base64: string; dataUrl: string; mimeType: string }> {
  const srcWidth =
    source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const srcHeight =
    source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;

  if (!srcWidth || !srcHeight) {
    throw new Error('Image dimensions could not be read.');
  }

  const scale = Math.min(1, maxDim / Math.max(srcWidth, srcHeight));
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable.');
  ctx.drawImage(source, 0, 0, width, height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
  const base64 = dataUrl.split(',')[1] || '';
  return { base64, dataUrl, mimeType: 'image/jpeg' };
}

async function computeImageFingerprint(base64: string, mimeType: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoded = new TextEncoder().encode(`${mimeType}:${base64}`);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return `${mimeType}:${base64.length}:${base64.slice(0, 64)}:${base64.slice(-64)}`;
}

export const CollectorDashboard: React.FC<CollectorDashboardProps> = ({
  profile,
  settings,
}) => {
  const [tab, setTab] = useState<CollectorTab>('scanner');

  // Firestore collections
  const [pendingCollections, setPendingCollections] = useState<WasteCollectionRecord[]>([]);
  const [myCollections, setMyCollections] = useState<WasteCollectionRecord[]>([]);
  const [residentCards, setResidentCards] = useState<ResidentCard[]>([]);

  // Resident Lookup / QR Scanner
  const [residentSearch, setResidentSearch] = useState('');
  const [activeResident, setActiveResident] = useState<ResidentCard | null>(null);
  const [activePendingRecord, setActivePendingRecord] =
    useState<WasteCollectionRecord | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  // QR Camera Modal/State
  const [qrCamOpen, setQrCamOpen] = useState(false);
  const [qrCamError, setQrCamError] = useState<string | null>(null);
  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrStreamRef = useRef<MediaStream | null>(null);
  const qrRafRef = useRef<number | null>(null);

  // Waste Camera / Photo State
  const [wasteCamOpen, setWasteCamOpen] = useState(false);
  const [wasteCamError, setWasteCamError] = useState<string | null>(null);
  const wasteVideoRef = useRef<HTMLVideoElement | null>(null);
  const wasteStreamRef = useRef<MediaStream | null>(null);

  const [capturedPreview, setCapturedPreview] = useState<string | null>(null);
  const [capturedPayload, setCapturedPayload] = useState<{
    base64: string;
    mimeType: string;
  } | null>(null);

  // AI Waste Classification State
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiErrorDetails, setAiErrorDetails] =
    useState<AiClassificationFailureDetails | null>(null);
  const [retryCooldownSec, setRetryCooldownSec] = useState(0);
  const [aiPrediction, setAiPrediction] = useState<AiWastePrediction | null>(null);
  const [scanSessionId, setScanSessionId] = useState<string | null>(null);
  const submittedScanIdsRef = useRef<Set<string>>(new Set());
  const classifyInFlightRef = useRef(false);
  const classificationCacheRef = useRef<Map<string, AiWastePrediction>>(new Map());

  // Submission Form State
  const [selectedCategory, setSelectedCategory] = useState<WasteCategory>('Plastic');
  const [weightKg, setWeightKg] = useState('2.0');
  const [collectionStatus, setCollectionStatus] = useState<'collected' | 'rejected'>('collected');
  const [notes, setNotes] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [guideImgFailed, setGuideImgFailed] = useState(false);

  const pointsByCategory = useMemo(
    () => ({
      ...DEFAULT_POINTS_BY_CATEGORY,
      ...(settings?.pointsByCategory || {}),
      'Other / Unrecognized': 0,
    }),
    [settings]
  );

  // Stop streams on unmount
  const stopQrCamera = useCallback(() => {
    if (qrRafRef.current !== null) {
      cancelAnimationFrame(qrRafRef.current);
      qrRafRef.current = null;
    }
    if (qrStreamRef.current) {
      qrStreamRef.current.getTracks().forEach((t) => t.stop());
      qrStreamRef.current = null;
    }
    setQrCamOpen(false);
  }, []);

  const stopWasteCamera = useCallback(() => {
    if (wasteStreamRef.current) {
      wasteStreamRef.current.getTracks().forEach((t) => t.stop());
      wasteStreamRef.current = null;
    }
    setWasteCamOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      stopQrCamera();
      stopWasteCamera();
    };
  }, [stopQrCamera, stopWasteCamera]);

  useEffect(() => {
    if (retryCooldownSec <= 0) return;
    const timer = window.setInterval(() => {
      setRetryCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryCooldownSec]);

  // Real-time Firestore listeners
  useEffect(() => {
    const pendingQ = query(
      collection(db, 'collections'),
      where('status', '==', 'pending')
    );
    const unsubPending = onSnapshot(
      pendingQ,
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as WasteCollectionRecord);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setPendingCollections(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'collections')
    );

    const historyQ = query(
      collection(db, 'collections'),
      where('collectorUid', '==', profile.uid)
    );
    const unsubHistory = onSnapshot(
      historyQ,
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as WasteCollectionRecord);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setMyCollections(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'collections')
    );

    const unsubCards = onSnapshot(
      collection(db, 'residentCards'),
      (snap) => {
        const rows = snap.docs
          .map((d) => d.data() as ResidentCard)
          .filter((c) => c.accountStatus === 'active');
        rows.sort((a, b) => a.name.localeCompare(b.name));
        setResidentCards(rows);
      },
      () => {
        // Non-blocking if restricted
      }
    );

    return () => {
      unsubPending();
      unsubHistory();
      unsubCards();
    };
  }, [profile.uid]);

  // Daily stats & category stats
  const dailyCompletedCount = useMemo(() => {
    const todayStr = new Date().toDateString();
    return myCollections.filter(
      (c) => c.status === 'collected' && toDate(c.updatedAt).toDateString() === todayStr
    ).length;
  }, [myCollections]);

  const categoryTotals = useMemo(() => {
    const map = new Map<string, { category: string; count: number; weightKg: number }>();
    for (const cat of WASTE_CATEGORIES) {
      map.set(cat, { category: cat, count: 0, weightKg: 0 });
    }
    for (const c of myCollections) {
      if (c.status === 'collected') {
        const item = map.get(c.category);
        if (item) {
          item.count += 1;
          item.weightKg = Number((item.weightKg + (c.weightKg || 0)).toFixed(1));
        }
      }
    }
    return Array.from(map.values());
  }, [myCollections]);

  const handleResidentLookup = async (rawId: string) => {
    setLookupError(null);
    setLookupBusy(true);
    try {
      const card = await lookupResidentByQrOrId(rawId);
      setActiveResident(card);
      setResidentSearch(card.residentId);
      setActivePendingRecord(null);
      setSubmitFeedback(null);
    } catch (err) {
      setActiveResident(null);
      setLookupError(err instanceof Error ? err.message : 'Unable to look up resident.');
    } finally {
      setLookupBusy(false);
    }
  };

  const handleLoadPendingIntoScanner = async (rec: WasteCollectionRecord) => {
    setTab('scanner');
    setLookupError(null);
    setLookupBusy(true);
    try {
      const card = await lookupResidentByQrOrId(rec.residentId);
      setActiveResident(card);
      setResidentSearch(card.residentId);
      setActivePendingRecord(rec);
      const mappedCat: WasteCategory = WASTE_CATEGORIES.includes(rec.category)
        ? rec.category
        : (rec.category as string) === 'Wet Waste'
          ? 'Organic'
          : (rec.category as string) === 'Polythene'
            ? 'Plastic'
            : 'Other / Unrecognized';
      setSelectedCategory(mappedCat);
      setWeightKg(String(rec.weightKg || 2.0));
      setNotes(rec.notes || '');
      setSubmitFeedback(null);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Could not load resident details.');
    } finally {
      setLookupBusy(false);
    }
  };

  const startQrScanner = async () => {
    stopWasteCamera();
    setQrCamError(null);
    setLookupError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setQrCamError('Camera access is not supported in this browser. Enter Resident ID manually or upload a QR image.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      qrStreamRef.current = stream;
      setQrCamOpen(true);

      requestAnimationFrame(() => {
        if (qrVideoRef.current) {
          qrVideoRef.current.srcObject = stream;
          qrVideoRef.current.play().catch(() => {});
        }
      });

      const scanCanvas = document.createElement('canvas');
      const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

      const tick = () => {
        const video = qrVideoRef.current;
        if (!video || !qrStreamRef.current) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA && scanCtx) {
          scanCanvas.width = video.videoWidth;
          scanCanvas.height = video.videoHeight;
          scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
          const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code && code.data) {
            stopQrCamera();
            handleResidentLookup(code.data);
            return;
          }
        }
        qrRafRef.current = requestAnimationFrame(tick);
      };
      qrRafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setQrCamError(
        err instanceof Error
          ? `Camera permission unavailable: ${err.message}. You can enter Resident ID manually or upload a QR image.`
          : 'Unable to access camera.'
      );
    }
  };

  const handleQrImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLookupError(null);

    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(data.data, data.width, data.height);
        URL.revokeObjectURL(objUrl);
        if (code && code.data) {
          handleResidentLookup(code.data);
        } else {
          setLookupError('No valid QR code detected in the uploaded image.');
        }
      } else {
        URL.revokeObjectURL(objUrl);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      setLookupError('Could not read the uploaded QR image.');
    };
    img.src = objUrl;
  };

  const startWasteCamera = async () => {
    stopQrCamera();
    setWasteCamError(null);
    setAiError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setWasteCamError('Camera API unavailable in this browser. Use Gallery Upload instead.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      wasteStreamRef.current = stream;
      setWasteCamOpen(true);

      requestAnimationFrame(() => {
        if (wasteVideoRef.current) {
          wasteVideoRef.current.srcObject = stream;
          wasteVideoRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
      setWasteCamError(
        err instanceof Error
          ? `Camera access denied or unavailable: ${err.message}. Use Gallery Upload below.`
          : 'Camera unavailable.'
      );
    }
  };

  const applyAiPrediction = (prediction: AiWastePrediction) => {
    setAiPrediction(prediction);

    if (
      !prediction.success ||
      prediction.humanDetected ||
      prediction.subjectType === 'human' ||
      prediction.category === 'Other / Unrecognized'
    ) {
      setSelectedCategory('Other / Unrecognized');
      setCollectionStatus('rejected');
      return;
    }

    setSelectedCategory(prediction.category);
    setCollectionStatus('collected');
  };

  const runAiClassification = async (base64: string, mimeType: string) => {
    if (classifyInFlightRef.current) return;

    const fingerprint = await computeImageFingerprint(base64, mimeType);
    const cachedPrediction = classificationCacheRef.current.get(fingerprint);
    if (cachedPrediction) {
      setAiError(null);
      setAiErrorDetails(null);
      setRetryCooldownSec(0);
      setSubmitFeedback(null);
      applyAiPrediction({ ...cachedPrediction, cached: true });
      return;
    }

    if (retryCooldownSec > 0) {
      return;
    }

    classifyInFlightRef.current = true;
    setAiLoading(true);
    setAiError(null);
    setAiErrorDetails(null);
    setAiPrediction(null);
    setSubmitFeedback(null);
    try {
      const prediction = await classifyWasteImage(base64, mimeType);
      classificationCacheRef.current.set(fingerprint, prediction);
      applyAiPrediction(prediction);
    } catch (err) {
      setSelectedCategory('Other / Unrecognized');
      setCollectionStatus('rejected');
      if (err instanceof AiClassificationError) {
        setAiError(err.details.message);
        setAiErrorDetails(err.details);
        if (err.details.retryable && err.details.retryAfterSeconds && err.details.retryAfterSeconds > 0) {
          setRetryCooldownSec(err.details.retryAfterSeconds);
        }
      } else {
        setAiError(
          err instanceof Error ? err.message : 'AI waste classification failed. Please retry.'
        );
      }
    } finally {
      classifyInFlightRef.current = false;
      setAiLoading(false);
    }
  };

  const captureWasteSnapshot = async () => {
    if (classifyInFlightRef.current || aiLoading) return;
    const video = wasteVideoRef.current;
    if (!video) return;
    try {
      const compressed = await compressImageToJpegBase64(video);
      stopWasteCamera();
      const nextScanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setScanSessionId(nextScanId);
      setCapturedPreview(compressed.dataUrl);
      setCapturedPayload({ base64: compressed.base64, mimeType: compressed.mimeType });
      await runAiClassification(compressed.base64, compressed.mimeType);
    } catch (err) {
      setWasteCamError(err instanceof Error ? err.message : 'Failed to capture frame.');
    }
  };

  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || classifyInFlightRef.current || aiLoading) return;

    setAiError(null);
    setAiErrorDetails(null);
    setWasteCamError(null);

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setAiError('Unsupported file type. Please choose a JPEG, PNG, WebP, or HEIC image.');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES * 2) {
      setAiError('Selected image file is too large (over 10 MB). Please choose a smaller photo.');
      return;
    }

    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        const compressed = await compressImageToJpegBase64(img);
        URL.revokeObjectURL(objUrl);
        const nextScanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setScanSessionId(nextScanId);
        setCapturedPreview(compressed.dataUrl);
        setCapturedPayload({ base64: compressed.base64, mimeType: compressed.mimeType });
        await runAiClassification(compressed.base64, compressed.mimeType);
      } catch (err) {
        URL.revokeObjectURL(objUrl);
        setAiError(err instanceof Error ? err.message : 'Failed to process image.');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      setAiError('Could not decode the selected image file.');
    };
    img.src = objUrl;
  };

  const handleAttachGps = () => {
    setGpsStatus(null);
    if (!navigator.geolocation) {
      setGpsStatus('Geolocation is not supported on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
        });
        setGpsStatus(
          `GPS attached (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`
        );
      },
      (err) => {
        setGpsStatus(`Location permission unavailable (${err.message}).`);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const isCurrentScanAlreadySubmitted = Boolean(
    scanSessionId && submittedScanIdsRef.current.has(scanSessionId)
  );

  const handleSubmitCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitFeedback(null);

    if (submitBusy) return;

    if (!activeResident) {
      setSubmitFeedback({
        type: 'error',
        text: 'Scan a resident QR pass or select a Resident first.',
      });
      return;
    }

    if (aiLoading) {
      setSubmitFeedback({
        type: 'error',
        text: 'Wait for AI waste analysis to finish before confirming.',
      });
      return;
    }

    if (scanSessionId && submittedScanIdsRef.current.has(scanSessionId)) {
      setSubmitFeedback({
        type: 'error',
        text: 'Points were already awarded for this scanned photo. Capture or upload a new photo for another collection.',
      });
      return;
    }

    if (
      collectionStatus === 'collected' &&
      (aiPrediction?.humanDetected || aiPrediction?.subjectType === 'human')
    ) {
      setSubmitFeedback({
        type: 'error',
        text: 'Human detected in photo — points cannot be awarded for people. Scan actual waste first.',
      });
      return;
    }

    if (collectionStatus === 'collected' && selectedCategory === 'Other / Unrecognized') {
      setSubmitFeedback({
        type: 'error',
        text: 'Points cannot be awarded for Other / Unrecognized waste. Select a recognized waste category or mark as Rejected.',
      });
      return;
    }

    setSubmitBusy(true);
    try {
      const collectorCorrected = aiPrediction
        ? selectedCategory !== aiPrediction.category
        : false;

      const res = await submitVerifiedCollection(profile, {
        existingPendingCollection: activePendingRecord,
        residentCard: activeResident,
        category: selectedCategory,
        weightKg: Number(weightKg) || 0,
        status: collectionStatus,
        aiPrediction,
        collectorCorrected,
        pointsByCategory,
        notes,
        latitude: coords?.lat,
        longitude: coords?.lng,
      });

      if (scanSessionId) {
        submittedScanIdsRef.current.add(scanSessionId);
      }

      setSubmitFeedback({
        type: 'success',
        text:
          collectionStatus === 'collected'
            ? `Collection ${res.collectionId} verified and saved! ${res.pointsAwarded} points awarded to ${activeResident.name}.`
            : `Collection ${res.collectionId} marked as rejected (0 points) and resident notified.`,
      });

      // Reset form for next stop
      setActivePendingRecord(null);
      setActiveResident(null);
      setResidentSearch('');
      setCapturedPreview(null);
      setCapturedPayload(null);
      setScanSessionId(null);
      setAiPrediction(null);
      setAiError(null);
      setAiErrorDetails(null);
      setRetryCooldownSec(0);
      setNotes('');
      setCoords(null);
      setGpsStatus(null);
    } catch (err) {
      setSubmitFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save collection record.',
      });
    } finally {
      setSubmitBusy(false);
    }
  };

  const collectorCorrected = aiPrediction
    ? selectedCategory !== aiPrediction.category
    : false;
  const previewPoints =
    collectionStatus === 'collected' && selectedCategory !== 'Other / Unrecognized'
      ? (pointsByCategory[selectedCategory] ?? DEFAULT_POINTS_BY_CATEGORY[selectedCategory] ?? 0)
      : 0;

  const navItems: { id: CollectorTab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'scanner', label: 'AI Scanner', icon: <ScanLine className="w-4 h-4" /> },
    {
      id: 'pending',
      label: 'Pending',
      icon: <ClipboardList className="w-4 h-4" />,
      count: pendingCollections.length,
    },
    { id: 'history', label: 'History', icon: <History className="w-4 h-4" /> },
  ];

  return (
    <div className="flex flex-1 min-h-0">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 shrink-0 bg-white border-r border-emerald-950/10 p-4 justify-between">
        <div className="space-y-1">
          <p className="px-3 py-2 text-xs font-semibold text-slate-400">
            Collector Operations
          </p>
          {navItems.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-emerald-900 text-white'
                    : 'text-slate-700 hover:bg-[#f6faf7] hover:text-emerald-950'
                }`}
              >
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  {item.icon}
                  {item.label}
                </span>
                {item.count !== undefined && (
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      active ? 'text-emerald-200' : 'text-amber-700 font-semibold'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="border-t border-emerald-950/10 pt-4 px-2 space-y-2">
          <div>
            <p className="text-xs text-slate-500">Assigned Zone</p>
            <p className="text-sm font-semibold text-slate-900 truncate">
              {profile.assignedArea || profile.area || 'General Zone'}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Completed Today</p>
            <p className="font-mono text-lg font-bold text-emerald-900 tabular-nums">
              {dailyCompletedCount}
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-10 max-w-6xl mx-auto w-full">
        {tab === 'scanner' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <div>
                <p className="text-xs text-slate-500">
                  Collector: {profile.name} · Zone: {profile.assignedArea || profile.area || 'All Zones'}
                </p>
                <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
                  Field QR & AI Waste Scanner
                </h1>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-600 font-mono tabular-nums">
                <span>Today: {dailyCompletedCount} completed</span>
                <span aria-hidden="true">·</span>
                <span>Queue: {pendingCollections.length} pending</span>
              </div>
            </div>

            {submitFeedback && (
              <div
                className={`p-4 rounded-2xl border text-sm flex items-start gap-2.5 ${
                  submitFeedback.type === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}
              >
                {submitFeedback.type === 'success' ? (
                  <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                )}
                <span>{submitFeedback.text}</span>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Step 1: Resident QR Scan / Search */}
              <div className="lg:col-span-5 space-y-6">
                <div className="bg-white border border-emerald-950/10 rounded-2xl p-6 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold text-emerald-800">Step 1</p>
                      <h2 className="font-display text-lg font-bold text-slate-900">
                        Identify Resident
                      </h2>
                    </div>
                    <QrCode className="w-5 h-5 text-emerald-800" />
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleResidentLookup(residentSearch);
                    }}
                    className="flex gap-2"
                  >
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={residentSearch}
                        onChange={(e) => setResidentSearch(e.target.value.toUpperCase())}
                        placeholder="ECO-XXXXXXXX"
                        className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={lookupBusy || !residentSearch.trim()}
                      className="px-4 py-2.5 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      {lookupBusy ? 'Finding...' : 'Lookup'}
                    </button>
                  </form>

                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={qrCamOpen ? stopQrCamera : startQrScanner}
                      className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-emerald-950/15 bg-[#f6faf7] hover:bg-emerald-100/60 text-emerald-950 text-xs font-semibold transition-colors cursor-pointer min-h-[44px]"
                    >
                      <QrCode className="w-4 h-4" />
                      {qrCamOpen ? 'Close QR Cam' : 'Scan QR Camera'}
                    </button>

                    <label className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-emerald-950/15 bg-white hover:bg-[#f6faf7] text-slate-800 text-xs font-semibold transition-colors cursor-pointer min-h-[44px]">
                      <ImagePlus className="w-4 h-4" />
                      Upload QR Image
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleQrImageUpload}
                        className="hidden"
                      />
                    </label>
                  </div>

                  {residentCards.length > 0 && (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Or Quick-Select Resident
                      </label>
                      <select
                        value={activeResident?.residentId || ''}
                        onChange={(e) => {
                          const found = residentCards.find(
                            (c) => c.residentId === e.target.value
                          );
                          if (found) {
                            setActiveResident(found);
                            setResidentSearch(found.residentId);
                            setActivePendingRecord(null);
                            setLookupError(null);
                            setSubmitFeedback(null);
                          }
                        }}
                        className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      >
                        <option value="">Choose a registered resident...</option>
                        {residentCards.map((c) => (
                          <option key={c.residentId} value={c.residentId}>
                            {c.name} ({c.residentId} · {c.rewardPoints} pts)
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {qrCamError && (
                    <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">
                      {qrCamError}
                    </p>
                  )}

                  {qrCamOpen && (
                    <div className="relative rounded-xl overflow-hidden bg-black aspect-square border border-emerald-950/15">
                      <video
                        ref={qrVideoRef}
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 border-2 border-emerald-400/70 m-8 rounded-xl pointer-events-none" />
                      <button
                        type="button"
                        onClick={stopQrCamera}
                        className="absolute top-3 right-3 p-2 rounded-lg bg-black/60 text-white hover:bg-black/80 cursor-pointer"
                        aria-label="Close QR camera"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {lookupError && (
                    <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{lookupError}</span>
                    </div>
                  )}

                  {activeResident && (
                    <div className="p-4 rounded-xl bg-[#f6faf7] border border-emerald-950/10 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-900">
                          <UserCheck className="w-4 h-4" />
                          Verified Resident
                        </span>
                        <span className="font-mono text-xs font-semibold text-emerald-950">
                          {activeResident.residentId}
                        </span>
                      </div>
                      <p className="font-display text-base font-bold text-slate-900">
                        {activeResident.name}
                      </p>
                      <p className="text-xs text-slate-600">
                        Zone: {activeResident.area || 'Unassigned'}
                      </p>
                      {activeResident.pickupAddress && (
                        <p className="text-xs text-slate-600">
                          Address: {activeResident.pickupAddress}
                        </p>
                      )}
                      <div className="pt-2 border-t border-emerald-950/10 flex items-center justify-between text-xs text-slate-600 font-mono tabular-nums">
                        <span>Balance: {activeResident.rewardPoints} pts</span>
                        <span>Pickups: {activeResident.totalCollections}</span>
                      </div>
                      {activePendingRecord && (
                        <p className="text-xs font-medium text-amber-800 pt-1">
                          Linked to Pending Request ({activePendingRecord.category})
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Sorting Reference Guide */}
                <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                  <h3 className="font-display text-sm font-bold text-slate-900 mb-2">
                    On-Site AI Capture Tips
                  </h3>
                  {!guideImgFailed && (
                    <img
                      src="/src/assets/images/scanner_sorting_guide_1795545520198.jpg"
                      alt="Cleanly separated recyclable items on a stone surface"
                      referrerPolicy="no-referrer"
                      onError={() => setGuideImgFailed(true)}
                      className="w-full h-36 object-cover rounded-xl mb-3 border border-emerald-950/10"
                    />
                  )}
                  <ul className="text-xs text-slate-600 space-y-1.5 leading-relaxed">
                    <li>• Center the waste item clearly in daylight or flash illumination.</li>
                    <li>• Keep hands, faces, and unrelated objects out of the frame.</li>
                    <li>• Always review and confirm the AI estimate before submitting points.</li>
                  </ul>
                </div>
              </div>

              {/* Step 2 & 3: Waste Photo Capture, Gemini AI Classification, and Confirm/Submit */}
              <div className="lg:col-span-7 bg-white border border-emerald-950/10 rounded-2xl p-6 space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-emerald-800">Step 2 & 3</p>
                    <h2 className="font-display text-lg font-bold text-slate-900">
                      Capture Waste Image & Classify with Gemini AI
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">
                      Review the AI prediction and confirm below before awarding reward points.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={wasteCamOpen ? stopWasteCamera : startWasteCamera}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 transition-colors cursor-pointer min-h-[44px]"
                    >
                      <Camera className="w-4 h-4" />
                      {wasteCamOpen ? 'Stop Camera' : 'Rear Camera'}
                    </button>
                    <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-emerald-950/15 bg-white hover:bg-[#f6faf7] text-slate-800 text-xs font-semibold transition-colors cursor-pointer min-h-[44px]">
                      <ImagePlus className="w-4 h-4" />
                      Gallery Upload
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic"
                        onChange={handleGalleryUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                {wasteCamError && (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs">
                    {wasteCamError}
                  </div>
                )}

                {wasteCamOpen && (
                  <div className="space-y-3">
                    <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3] border border-emerald-950/15">
                      <video
                        ref={wasteVideoRef}
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={aiLoading}
                      onClick={captureWasteSnapshot}
                      className="w-full py-3 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {aiLoading ? 'Analyzing...' : 'Capture & Analyze Waste Photo'}
                    </button>
                  </div>
                )}

                {capturedPreview && !wasteCamOpen && (
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-start">
                    <div className="sm:col-span-5 relative rounded-xl overflow-hidden border border-emerald-950/10 bg-slate-100 aspect-[4/3]">
                      <img
                        src={capturedPreview}
                        alt="Captured waste sample"
                        className="w-full h-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setCapturedPreview(null);
                          setCapturedPayload(null);
                          setScanSessionId(null);
                          setAiPrediction(null);
                          setAiError(null);
                          setAiErrorDetails(null);
                          setRetryCooldownSec(0);
                        }}
                        className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/65 text-white hover:bg-black/80 cursor-pointer"
                        aria-label="Clear captured photo"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="sm:col-span-7">
                      {aiLoading && (
                        <div className="p-4 rounded-xl bg-[#f6faf7] border border-emerald-950/10 flex items-center gap-3 text-sm text-emerald-950">
                          <Loader2 className="w-5 h-5 animate-spin shrink-0" />
                          <span>Analyzing image with Gemini AI...</span>
                        </div>
                      )}

                      {aiError && (
                        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 space-y-2.5 text-xs">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                            <div className="space-y-1">
                              <p className="font-semibold text-rose-900">{aiError}</p>
                              {aiErrorDetails && (
                                <p className="font-mono text-[11px] text-rose-700">
                                  Status: HTTP {aiErrorDetails.upstreamStatus ?? aiErrorDetails.httpStatus}
                                  {aiErrorDetails.upstreamErrorStatus
                                    ? ` (${aiErrorDetails.upstreamErrorStatus})`
                                    : ''}
                                  {' · '}
                                  {aiErrorDetails.code}
                                </p>
                              )}
                              {aiErrorDetails?.diagnosticDetail && (
                                <p className="text-[11px] text-rose-700/90 leading-relaxed break-words">
                                  {aiErrorDetails.diagnosticDetail}
                                </p>
                              )}
                            </div>
                          </div>

                          {retryCooldownSec > 0 && (
                            <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                              <Clock className="w-3.5 h-3.5 shrink-0" />
                              <span>Rate limit cooldown: retry available in {retryCooldownSec}s</span>
                            </div>
                          )}

                          {aiErrorDetails && !aiErrorDetails.retryable && (
                            <p className="text-[11px] text-rose-900 bg-white border border-rose-200 rounded-lg p-2">
                              {aiErrorDetails.quotaCategory === 'daily_quota'
                                ? 'Automatic retries paused because the project daily Gemini quota (RPD) is exhausted. No points were awarded.'
                                : aiErrorDetails.quotaCategory === 'billing_or_spend_cap'
                                  ? 'Automatic retries paused. Verify Gemini API billing or spend cap settings in Google AI Studio / Google Cloud Console.'
                                  : 'Check the error detail above or upload a different supported image.'}
                            </p>
                          )}

                          {capturedPayload && (
                            <button
                              type="button"
                              disabled={
                                aiLoading ||
                                retryCooldownSec > 0 ||
                                aiErrorDetails?.retryable === false
                              }
                              onClick={() =>
                                runAiClassification(
                                  capturedPayload.base64,
                                  capturedPayload.mimeType
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-700 text-white font-semibold hover:bg-rose-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              {retryCooldownSec > 0
                                ? `Retry in ${retryCooldownSec}s`
                                : 'Retry AI Analysis'}
                            </button>
                          )}
                        </div>
                      )}

                      {aiPrediction && (aiPrediction.humanDetected || aiPrediction.subjectType === 'human') && (
                        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-rose-800">
                              <UserX className="w-4 h-4" />
                              Human Detected
                            </span>
                            <span className="font-mono text-xs text-rose-700 tabular-nums">
                              0 Points
                            </span>
                          </div>
                          <p className="font-display text-lg font-bold text-rose-950">
                            {aiPrediction.detectedSubject || 'Person / Human Detected'}
                          </p>
                          <p className="text-xs text-rose-800 leading-relaxed">
                            {aiPrediction.description || aiPrediction.explanation}
                          </p>
                          <p className="text-xs text-rose-900 bg-white border border-rose-200 rounded-lg p-2.5">
                            {aiPrediction.disposalSuggestion}
                          </p>
                          {capturedPayload && (
                            <button
                              type="button"
                              disabled={aiLoading}
                              onClick={() =>
                                runAiClassification(
                                  capturedPayload.base64,
                                  capturedPayload.mimeType
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-300 bg-white text-rose-800 text-xs font-semibold hover:bg-rose-100 cursor-pointer disabled:opacity-50"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              Retry AI Analysis
                            </button>
                          )}
                        </div>
                      )}

                      {aiPrediction && !aiPrediction.humanDetected && !aiPrediction.success && (
                        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-800">
                              <AlertTriangle className="w-4 h-4" />
                              {aiPrediction.category}
                            </span>
                            <span className="font-mono text-xs text-amber-800 tabular-nums">
                              0 pts · Est. ~{aiPrediction.confidence}%
                            </span>
                          </div>
                          <p className="font-display text-lg font-bold text-amber-950">
                            {aiPrediction.detectedSubject}
                          </p>
                          <p className="text-xs text-amber-900 leading-relaxed">
                            {aiPrediction.description || aiPrediction.explanation}
                          </p>
                          <p className="text-xs text-amber-900 bg-white border border-amber-200 rounded-lg p-2.5">
                            {aiPrediction.disposalSuggestion}
                          </p>
                          {capturedPayload && (
                            <button
                              type="button"
                              disabled={aiLoading}
                              onClick={() =>
                                runAiClassification(
                                  capturedPayload.base64,
                                  capturedPayload.mimeType
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-900 text-xs font-semibold hover:bg-amber-100 cursor-pointer disabled:opacity-50"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              Retry AI Analysis
                            </button>
                          )}
                        </div>
                      )}

                      {aiPrediction && !aiPrediction.humanDetected && aiPrediction.success && (
                        <div className="p-4 rounded-xl bg-[#f6faf7] border border-emerald-950/15 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-900">
                              <CheckCircle2 className="w-4 h-4" />
                              Waste Classified
                            </span>
                            <span className="font-mono text-xs text-slate-600 tabular-nums">
                              Est. Confidence: ~{aiPrediction.confidence}%
                            </span>
                          </div>
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="font-display text-lg font-bold text-slate-900">
                              {aiPrediction.category}
                            </p>
                            <span className="font-mono text-sm font-bold text-emerald-800 tabular-nums">
                              +{pointsByCategory[aiPrediction.category] ?? aiPrediction.points} pts on confirm
                            </span>
                          </div>
                          <p className="text-xs font-medium text-slate-700">
                            Detected Item: {aiPrediction.detectedSubject} · {aiPrediction.recyclable ? 'Recyclable' : 'Organic / Non-Recyclable'}
                          </p>
                          <p className="text-xs text-slate-700 leading-relaxed">
                            {aiPrediction.description || aiPrediction.explanation}
                          </p>
                          <p className="text-xs text-emerald-900 bg-white border border-emerald-950/10 rounded-lg p-2.5">
                            Disposal: {aiPrediction.disposalSuggestion}
                          </p>

                          <div className="flex items-center justify-between gap-2 pt-1">
                            {!activeResident ? (
                              <span className="text-xs text-amber-800 font-medium">
                                Select or scan a Resident in Step 1 to confirm and award points.
                              </span>
                            ) : (
                              <span className="text-xs text-emerald-900 font-medium flex items-center gap-1.5">
                                <Award className="w-3.5 h-3.5 shrink-0" />
                                Ready to confirm for {activeResident.name}
                              </span>
                            )}
                            {capturedPayload && (
                              <button
                                type="button"
                                disabled={aiLoading}
                                onClick={() =>
                                  runAiClassification(
                                    capturedPayload.base64,
                                    capturedPayload.mimeType
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-950/15 bg-white text-slate-700 text-[11px] font-semibold hover:bg-emerald-50 cursor-pointer shrink-0 disabled:opacity-50"
                              >
                                <RefreshCw className="w-3 h-3" />
                                Retry AI Analysis
                              </button>
                            )}
                          </div>

                          <p className="text-[11px] text-slate-500">
                            {aiPrediction.disclaimer}
                            {aiPrediction.cached ? ' · Saved classification reused (no extra API call).' : ''}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Collector Verification & Submission Form */}
                <form
                  onSubmit={handleSubmitCollection}
                  className="pt-4 border-t border-slate-100 space-y-4"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Confirmed Waste Category {collectorCorrected ? '(Corrected from AI)' : ''}
                      </label>
                      <select
                        value={selectedCategory}
                        onChange={(e) => setSelectedCategory(e.target.value as WasteCategory)}
                        className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      >
                        {WASTE_CATEGORIES.map((cat) => (
                          <option key={cat} value={cat}>
                            {cat} ({pointsByCategory[cat] ?? DEFAULT_POINTS_BY_CATEGORY[cat]} pts)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Weight (kg)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="500"
                        required
                        value={weightKg}
                        onChange={(e) => setWeightKg(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Collection Decision
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setCollectionStatus('collected')}
                          className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold border transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                            collectionStatus === 'collected'
                              ? 'bg-emerald-900 text-white border-emerald-900'
                              : 'bg-white text-slate-700 border-emerald-950/15'
                          }`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Collected (+{previewPoints} pts)
                        </button>
                        <button
                          type="button"
                          onClick={() => setCollectionStatus('rejected')}
                          className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold border transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                            collectionStatus === 'rejected'
                              ? 'bg-rose-700 text-white border-rose-700'
                              : 'bg-white text-slate-700 border-emerald-950/15'
                          }`}
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Reject (0 pts)
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Collector Notes
                      </label>
                      <input
                        type="text"
                        maxLength={400}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Optional sorting or contamination note"
                        className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
                    <div>
                      <button
                        type="button"
                        onClick={handleAttachGps}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-emerald-950/15 text-xs font-semibold text-slate-700 hover:bg-[#f6faf7] cursor-pointer"
                      >
                        <MapPin className="w-3.5 h-3.5 text-emerald-800" />
                        {coords ? 'GPS Verified' : 'Attach Optional Pickup GPS'}
                      </button>
                      {gpsStatus && (
                        <p className="text-[11px] text-emerald-800 mt-1">{gpsStatus}</p>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={
                        submitBusy ||
                        aiLoading ||
                        !activeResident ||
                        isCurrentScanAlreadySubmitted ||
                        (collectionStatus === 'collected' &&
                          (selectedCategory === 'Other / Unrecognized' ||
                            Boolean(
                              aiPrediction?.humanDetected ||
                                aiPrediction?.subjectType === 'human'
                            )))
                      }
                      className="px-6 py-3 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {isCurrentScanAlreadySubmitted
                        ? 'Points Already Awarded for This Scan'
                        : submitBusy
                          ? 'Saving Record...'
                          : collectionStatus === 'collected'
                            ? `Confirm & Award ${previewPoints} Points`
                            : 'Submit Rejection (0 Points)'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

        {tab === 'pending' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Pending Resident Pickup Requests
              </h1>
              <p className="text-xs text-slate-500">
                Select any pending pickup to load the resident into the AI scanner
              </p>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl divide-y divide-slate-100">
              {pendingCollections.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No pending pickup requests right now.
                </div>
              ) : (
                pendingCollections.map((rec) => (
                  <div
                    key={rec.collectionId}
                    className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[#f6faf7]/60"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono font-semibold text-emerald-950">
                          {rec.residentId}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{rec.area}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimestamp(rec.createdAt)}</span>
                      </div>
                      <p className="font-display font-bold text-slate-900">
                        {rec.residentName} — {rec.category} ({rec.weightKg.toFixed(1)} kg)
                      </p>
                      {rec.address && (
                        <p className="text-xs text-slate-600">Address: {rec.address}</p>
                      )}
                      {rec.notes && (
                        <p className="text-xs text-slate-500">Note: {rec.notes}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleLoadPendingIntoScanner(rec)}
                      className="px-4 py-2.5 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 transition-colors cursor-pointer shrink-0"
                    >
                      Verify & Scan
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'history' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Collector History & Category Totals
              </h1>
              <p className="text-xs text-slate-500">
                Total waste collected across all verified pickups by {profile.name}
              </p>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl p-6">
              <h2 className="font-display text-base font-bold text-slate-900 mb-4">
                Total Waste Collected by Category (kg)
              </h2>
              <div className="h-60 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={categoryTotals}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="category" tick={{ fontSize: 11, fill: '#475569' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#475569' }} />
                    <Tooltip />
                    <Bar dataKey="weightKg" name="Weight (kg)" fill="#14532d" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl overflow-hidden">
              {myCollections.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No completed collections recorded by your account yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 text-xs text-slate-500 bg-[#f6faf7]">
                        <th className="py-3 px-4 font-semibold">Date</th>
                        <th className="py-3 px-4 font-semibold">Resident</th>
                        <th className="py-3 px-4 font-semibold">Category</th>
                        <th className="py-3 px-4 font-semibold">AI Match</th>
                        <th className="py-3 px-4 font-semibold text-right">Weight</th>
                        <th className="py-3 px-4 font-semibold text-right">Points</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {myCollections.map((row) => (
                        <tr key={row.collectionId} className="hover:bg-[#f6faf7]/60">
                          <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap">
                            {formatTimestamp(row.updatedAt)}
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-medium text-slate-900">{row.residentName}</span>
                            <span className="block font-mono text-[11px] text-slate-500">
                              {row.residentId}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-900">{row.category}</td>
                          <td className="py-3 px-4 text-xs text-slate-600">
                            {row.aiCategory
                              ? row.collectorCorrected
                                ? `Corrected (AI: ${row.aiCategory})`
                                : `Confirmed (${row.aiConfidence ?? 0}%)`
                              : 'Manual entry'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            {row.weightKg.toFixed(1)} kg
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-emerald-800 tabular-nums">
                            +{row.pointsAwarded}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-emerald-950/10 grid grid-cols-3 h-16">
        {navItems.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex flex-col items-center justify-center min-h-[44px] text-[10px] font-medium cursor-pointer ${
                active ? 'text-emerald-900 font-semibold' : 'text-slate-500'
              }`}
            >
              {item.icon}
              <span className="mt-1">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
