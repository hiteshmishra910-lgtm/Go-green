import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import {
  Award,
  Bell,
  Calendar,
  CheckCircle2,
  Clock,
  LayoutDashboard,
  MapPin,
  Plus,
  Recycle,
  ShieldAlert,
  Trophy,
  User as UserIcon,
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
  createPickupRequest,
  formatTimestamp,
  markNotificationRead,
  submitCollectorApplication,
  toDate,
  updateResidentProfile,
} from '../lib/ecoService';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  type AppSettings,
  type CollectorApplication,
  DEFAULT_SERVICE_AREAS,
  type LeaderboardEntry,
  type NotificationRecord,
  type RewardTransaction,
  type UserProfile,
  WASTE_CATEGORIES,
  type WasteCategory,
  type WasteCollectionRecord,
} from '../types/ecoverify';
import { QrCodeCard } from './QrCodeCard';

type ResidentTab = 'overview' | 'history' | 'leaderboard' | 'notifications' | 'profile';

interface ResidentDashboardProps {
  profile: UserProfile;
  settings: AppSettings | null;
}

export const ResidentDashboard: React.FC<ResidentDashboardProps> = ({
  profile,
  settings,
}) => {
  const [tab, setTab] = useState<ResidentTab>('overview');
  const [collections, setCollections] = useState<WasteCollectionRecord[]>([]);
  const [transactions, setTransactions] = useState<RewardTransaction[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [collectorApp, setCollectorApp] = useState<CollectorApplication | null>(null);
  const [loadingData, setLoadingData] = useState(true);

  // Pickup request form
  const [pickupCategory, setPickupCategory] = useState<WasteCategory>('Plastic');
  const [pickupWeight, setPickupWeight] = useState('2.5');
  const [pickupNotes, setPickupNotes] = useState('');
  const [pickupCoords, setPickupCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsNotice, setGpsNotice] = useState<string | null>(null);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [pickupFeedback, setPickupFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // History status filter
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'collected' | 'rejected'>('all');

  // Profile edit form
  const [editName, setEditName] = useState(profile.name);
  const [editPhone, setEditPhone] = useState(profile.phone || '');
  const [editAddress, setEditAddress] = useState(profile.address || '');
  const [editArea, setEditArea] = useState(profile.area || DEFAULT_SERVICE_AREAS[0]);
  const [editPhoto, setEditPhoto] = useState(profile.photoUrl || '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Collector application form
  const [appPhone, setAppPhone] = useState(profile.phone || '');
  const [appArea, setAppArea] = useState(profile.area || DEFAULT_SERVICE_AREAS[0]);
  const [appBadge, setAppBadge] = useState('');
  const [appNotes, setAppNotes] = useState('');
  const [appBusy, setAppBusy] = useState(false);
  const [appFeedback, setAppFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const serviceAreas = settings?.serviceAreas?.length
    ? settings.serviceAreas
    : DEFAULT_SERVICE_AREAS;

  useEffect(() => {
    setEditName(profile.name);
    setEditPhone(profile.phone || '');
    setEditAddress(profile.address || '');
    setEditArea(profile.area || serviceAreas[0]);
    setEditPhoto(profile.photoUrl || '');
  }, [profile, serviceAreas]);

  useEffect(() => {
    let settled = false;
    const markSettled = () => {
      if (!settled) {
        settled = true;
        setLoadingData(false);
      }
    };

    const colQ = query(
      collection(db, 'collections'),
      where('residentUid', '==', profile.uid)
    );
    const unsubCols = onSnapshot(
      colQ,
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as WasteCollectionRecord);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setCollections(rows);
        markSettled();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'collections')
    );

    const txQ = query(
      collection(db, 'rewardTransactions'),
      where('residentUid', '==', profile.uid)
    );
    const unsubTx = onSnapshot(
      txQ,
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as RewardTransaction);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setTransactions(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'rewardTransactions')
    );

    const lbQ = query(
      collection(db, 'leaderboard'),
      orderBy('rewardPoints', 'desc'),
      limit(10)
    );
    const unsubLb = onSnapshot(
      lbQ,
      (snap) => {
        setLeaderboard(snap.docs.map((d) => d.data() as LeaderboardEntry));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'leaderboard')
    );

    const notifQ = query(
      collection(db, 'notifications'),
      where('recipientUid', '==', profile.uid)
    );
    const unsubNotif = onSnapshot(
      notifQ,
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as NotificationRecord);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setNotifications(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'notifications')
    );

    const unsubApp = onSnapshot(
      doc(db, 'collectorApplications', profile.uid),
      (snap) => {
        setCollectorApp(snap.exists() ? (snap.data() as CollectorApplication) : null);
      },
      (err) =>
        handleFirestoreError(err, OperationType.GET, `collectorApplications/${profile.uid}`)
    );

    return () => {
      unsubCols();
      unsubTx();
      unsubLb();
      unsubNotif();
      unsubApp();
    };
  }, [profile.uid]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications]
  );

  const collectedList = useMemo(
    () => collections.filter((c) => c.status === 'collected'),
    [collections]
  );

  const pendingList = useMemo(
    () => collections.filter((c) => c.status === 'pending'),
    [collections]
  );

  const myRank = useMemo(() => {
    const idx = leaderboard.findIndex((e) => e.uid === profile.uid);
    return idx >= 0 ? `#${idx + 1}` : 'Top 10+';
  }, [leaderboard, profile.uid]);

  const monthlyChartData = useMemo(() => {
    const map = new Map<string, { month: string; collections: number; weightKg: number }>();
    const now = new Date();
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleString(undefined, { month: 'short' });
      map.set(key, { month: label, collections: 0, weightKg: 0 });
    }
    for (const c of collectedList) {
      const d = toDate(c.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const bucket = map.get(key);
      if (bucket) {
        bucket.collections += 1;
        bucket.weightKg = Number((bucket.weightKg + (c.weightKg || 0)).toFixed(1));
      }
    }
    return Array.from(map.values());
  }, [collectedList]);

  const categoryBreakdown = useMemo(() => {
    const counts = new Map<string, { category: string; count: number; weightKg: number }>();
    for (const cat of WASTE_CATEGORIES) {
      counts.set(cat, { category: cat, count: 0, weightKg: 0 });
    }
    for (const c of collectedList) {
      const entry = counts.get(c.category);
      if (entry) {
        entry.count += 1;
        entry.weightKg = Number((entry.weightKg + (c.weightKg || 0)).toFixed(1));
      }
    }
    return Array.from(counts.values()).filter((x) => x.count > 0);
  }, [collectedList]);

  const filteredHistory = useMemo(() => {
    if (statusFilter === 'all') return collections;
    return collections.filter((c) => c.status === statusFilter);
  }, [collections, statusFilter]);

  const handleRequestGps = () => {
    setGpsNotice(null);
    if (!navigator.geolocation) {
      setGpsNotice('Geolocation is not supported by this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPickupCoords({
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
        });
        setGpsNotice(
          `Location attached (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}) to help your collector locate the pickup.`
        );
      },
      (err) => {
        setGpsNotice(`Location permission declined or unavailable (${err.message}).`);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleCreatePickup = async (e: React.FormEvent) => {
    e.preventDefault();
    setPickupFeedback(null);
    setPickupBusy(true);
    try {
      await createPickupRequest(profile, {
        category: pickupCategory,
        weightKg: Number(pickupWeight) || 0,
        notes: pickupNotes,
        latitude: pickupCoords?.lat,
        longitude: pickupCoords?.lng,
      });
      setPickupNotes('');
      setPickupCoords(null);
      setGpsNotice(null);
      setPickupFeedback({
        type: 'success',
        text: 'Pickup request submitted! Your collector can now scan your QR pass on arrival.',
      });
    } catch (err) {
      setPickupFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to create pickup request.',
      });
    } finally {
      setPickupBusy(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileFeedback(null);
    setProfileBusy(true);
    try {
      await updateResidentProfile(profile, {
        name: editName,
        phone: editPhone,
        address: editAddress,
        area: editArea,
        photoUrl: editPhoto,
      });
      setProfileFeedback({ type: 'success', text: 'Resident profile updated in Firestore.' });
    } catch (err) {
      setProfileFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to update profile.',
      });
    } finally {
      setProfileBusy(false);
    }
  };

  const handleCollectorApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setAppFeedback(null);
    setAppBusy(true);
    try {
      await submitCollectorApplication(profile, {
        phone: appPhone,
        preferredArea: appArea,
        badgeNumber: appBadge,
        notes: appNotes,
      });
      setAppFeedback({
        type: 'success',
        text: 'Collector application submitted for administrator approval.',
      });
    } catch (err) {
      setAppFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to submit application.',
      });
    } finally {
      setAppBusy(false);
    }
  };

  const renderStatusBadge = (status: string) => {
    if (status === 'collected') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Collected
        </span>
      );
    }
    if (status === 'rejected') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700">
          <XCircle className="w-3.5 h-3.5" />
          Rejected
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
        <Clock className="w-3.5 h-3.5" />
        Pending
      </span>
    );
  };

  const navItems: { id: ResidentTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: 'history', label: 'Collections', icon: <Recycle className="w-4 h-4" /> },
    { id: 'leaderboard', label: 'Leaderboard', icon: <Trophy className="w-4 h-4" /> },
    {
      id: 'notifications',
      label: 'Alerts',
      icon: <Bell className="w-4 h-4" />,
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    { id: 'profile', label: 'Profile', icon: <UserIcon className="w-4 h-4" /> },
  ];

  return (
    <div className="flex flex-1 min-h-0">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 shrink-0 bg-white border-r border-emerald-950/10 p-4 justify-between">
        <div className="space-y-1">
          <p className="px-3 py-2 text-xs font-semibold text-slate-400">
            Resident Portal
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
                {item.badge !== undefined && (
                  <span
                    className={`font-mono text-xs tabular-nums ${
                      active ? 'text-emerald-200' : 'text-emerald-800 font-semibold'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="border-t border-emerald-950/10 pt-4 px-2">
          <p className="text-xs text-slate-500">Resident ID</p>
          <p className="font-mono text-sm font-semibold text-emerald-950 tabular-nums">
            {profile.residentId}
          </p>
          <p className="text-xs text-slate-500 mt-1 truncate">
            {profile.area || 'No zone assigned'}
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-10 max-w-6xl mx-auto w-full">
        {profile.accountStatus !== 'active' && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 text-amber-900 text-sm">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Account Status: {profile.accountStatus}</p>
              <p className="text-xs mt-0.5">
                Your account is currently {profile.accountStatus}. Contact a municipal administrator for reactivation.
              </p>
            </div>
          </div>
        )}

        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500">
                  {profile.area || 'Service Area'} · {profile.residentId}
                </p>
                <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
                  Welcome back, {profile.name}
                </h1>
              </div>
              <button
                type="button"
                onClick={() => setTab('history')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-emerald-950/15 bg-white text-sm font-semibold text-slate-800 hover:bg-[#f6faf7] transition-colors cursor-pointer self-start sm:self-auto"
              >
                <Calendar className="w-4 h-4 text-emerald-800" />
                View All History
              </button>
            </div>

            {/* 4 KPI Strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Earned Reward Points</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-emerald-900 tabular-nums">
                  {profile.rewardPoints.toLocaleString()}
                </p>
                <p className="text-xs text-slate-500 mt-1">Verified ledger balance</p>
              </div>
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Verified Pickups</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
                  {collectedList.length}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {collectedList.reduce((acc, c) => acc + (c.weightKg || 0), 0).toFixed(1)} kg recycled
                </p>
              </div>
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Pending Requests</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
                  {pendingList.length}
                </p>
                <p className="text-xs text-slate-500 mt-1">Awaiting collector scan</p>
              </div>
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Leaderboard Rank</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
                  {myRank}
                </p>
                <p className="text-xs text-slate-500 mt-1">City sustainability standing</p>
              </div>
            </div>

            {/* Main Grid: QR Pass + Request Pickup + Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-4 space-y-6">
                <QrCodeCard
                  residentId={profile.residentId}
                  residentName={profile.name}
                  area={profile.area || ''}
                />
              </div>

              <div className="lg:col-span-8 space-y-6">
                {/* Schedule Pickup Request */}
                <div className="bg-white border border-emerald-950/10 rounded-2xl p-6">
                  <div className="flex items-center justify-between gap-4 mb-4">
                    <div>
                      <h2 className="font-display text-lg font-bold text-slate-900">
                        Schedule Waste Pickup
                      </h2>
                      <p className="text-xs text-slate-500">
                        Log sorted waste ready for collection. Points are awarded once a collector verifies on-site.
                      </p>
                    </div>
                  </div>

                  {pickupFeedback && (
                    <div
                      className={`mb-4 p-3 rounded-xl text-xs border ${
                        pickupFeedback.type === 'success'
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                          : 'bg-rose-50 border-rose-200 text-rose-800'
                      }`}
                    >
                      {pickupFeedback.text}
                    </div>
                  )}

                  <form onSubmit={handleCreatePickup} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Waste Category
                        </label>
                        <select
                          value={pickupCategory}
                          onChange={(e) => setPickupCategory(e.target.value as WasteCategory)}
                          className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        >
                          {WASTE_CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Estimated Weight (kg)
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="500"
                          required
                          value={pickupWeight}
                          onChange={(e) => setPickupWeight(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Pickup Notes (Optional)
                      </label>
                      <input
                        type="text"
                        maxLength={300}
                        value={pickupNotes}
                        onChange={(e) => setPickupNotes(e.target.value)}
                        placeholder="e.g., 2 bags placed outside main gate"
                        className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                      <div>
                        <button
                          type="button"
                          onClick={handleRequestGps}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-emerald-950/15 text-xs font-semibold text-slate-700 hover:bg-[#f6faf7] transition-colors cursor-pointer"
                        >
                          <MapPin className="w-3.5 h-3.5 text-emerald-800" />
                          {pickupCoords ? 'GPS Location Attached' : 'Attach Optional GPS Pin'}
                        </button>
                        <p className="text-[11px] text-slate-500 mt-1">
                          Optional: shares your pickup coordinates only with collectors for this request.
                        </p>
                        {gpsNotice && (
                          <p className="text-[11px] text-emerald-800 mt-1">{gpsNotice}</p>
                        )}
                      </div>

                      <button
                        type="submit"
                        disabled={pickupBusy || profile.accountStatus !== 'active'}
                        className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                      >
                        <Plus className="w-4 h-4" />
                        {pickupBusy ? 'Submitting...' : 'Request Pickup'}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Monthly Statistics Chart */}
                <div className="bg-white border border-emerald-950/10 rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="font-display text-lg font-bold text-slate-900">
                        Monthly Collection Statistics
                      </h2>
                      <p className="text-xs text-slate-500">
                        Verified waste pickups and recycled kilograms over the past 6 months
                      </p>
                    </div>
                  </div>
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={monthlyChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#475569' }} />
                        <YAxis tick={{ fontSize: 12, fill: '#475569' }} />
                        <Tooltip />
                        <Bar dataKey="weightKg" name="Weight (kg)" fill="#14532d" radius={[6, 6, 0, 0]} />
                        <Bar dataKey="collections" name="Collections" fill="#10b981" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Waste Categories Collected */}
                <div className="bg-white border border-emerald-950/10 rounded-2xl p-6">
                  <h2 className="font-display text-lg font-bold text-slate-900 mb-1">
                    Waste Categories Collected
                  </h2>
                  <p className="text-xs text-slate-500 mb-4">
                    Verified materials sorted by your household
                  </p>
                  {categoryBreakdown.length === 0 ? (
                    <p className="text-sm text-slate-500 py-4">
                      No verified collections recorded yet. Schedule a pickup or present your QR pass to a collector.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {categoryBreakdown.map((item) => (
                        <div
                          key={item.category}
                          className="py-2.5 flex items-center justify-between text-sm"
                        >
                          <span className="font-medium text-slate-800">{item.category}</span>
                          <span className="font-mono text-xs text-slate-600 tabular-nums">
                            {item.count} pickups · {item.weightKg} kg
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'history' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-slate-900">
                  Collection History & Reward Ledger
                </h1>
                <p className="text-xs text-slate-500">
                  Real-time status tracking for every waste collection and reward credit
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 bg-white border border-emerald-950/10 rounded-xl self-start">
                {(['all', 'pending', 'collected', 'rejected'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg capitalize transition-colors cursor-pointer ${
                      statusFilter === st
                        ? 'bg-emerald-900 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl overflow-hidden">
              {loadingData ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Loading collection records...
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm text-slate-600 mb-3">
                    No {statusFilter === 'all' ? '' : statusFilter} collection records found.
                  </p>
                  <button
                    type="button"
                    onClick={() => setTab('overview')}
                    className="px-4 py-2 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
                  >
                    Schedule First Pickup
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 text-xs text-slate-500 bg-[#f6faf7]">
                        <th className="py-3 px-4 font-semibold">Date</th>
                        <th className="py-3 px-4 font-semibold">Category</th>
                        <th className="py-3 px-4 font-semibold">Status</th>
                        <th className="py-3 px-4 font-semibold text-right">Weight</th>
                        <th className="py-3 px-4 font-semibold text-right">Points</th>
                        <th className="py-3 px-4 font-semibold">Collector</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {filteredHistory.map((row) => (
                        <tr key={row.collectionId} className="hover:bg-[#f6faf7]/70">
                          <td className="py-3 px-4 text-xs text-slate-600 font-mono tabular-nums whitespace-nowrap">
                            {formatTimestamp(row.createdAt)}
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-900">
                            <div>{row.category}</div>
                            {row.aiExplanation && (
                              <p className="text-xs text-slate-500 max-w-xs truncate">
                                {row.aiExplanation}
                              </p>
                            )}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            {renderStatusBadge(row.status)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                            {row.weightKg.toFixed(1)} kg
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-emerald-800">
                            +{row.pointsAwarded}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">
                            {row.collectorName || 'Awaiting pickup'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Reward Points Ledger */}
            <div className="bg-white border border-emerald-950/10 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <Award className="w-5 h-5 text-emerald-800" />
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Reward Points Transaction History
                </h2>
              </div>
              {transactions.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No reward transactions yet. Points are credited after collector verification.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {transactions.map((tx) => (
                    <div
                      key={tx.txId}
                      className="py-3 flex items-center justify-between gap-4 text-sm"
                    >
                      <div>
                        <p className="font-medium text-slate-900">{tx.reason}</p>
                        <p className="text-xs text-slate-500">
                          {formatTimestamp(tx.createdAt)} · Verified by {tx.awardedByRole}
                        </p>
                      </div>
                      <span
                        className={`font-mono text-sm font-bold tabular-nums whitespace-nowrap ${
                          tx.points >= 0 ? 'text-emerald-800' : 'text-rose-700'
                        }`}
                      >
                        {tx.points >= 0 ? `+${tx.points}` : tx.points} pts
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'leaderboard' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Top 10 Sustainability Leaderboard
              </h1>
              <p className="text-xs text-slate-500">
                Ranked by verified reward points across municipal zones (private contact info is never shared)
              </p>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl overflow-hidden">
              {leaderboard.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No leaderboard entries recorded yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 text-xs text-slate-500 bg-[#f6faf7]">
                        <th className="py-3 px-4 font-semibold">Rank</th>
                        <th className="py-3 px-4 font-semibold">Resident</th>
                        <th className="py-3 px-4 font-semibold">Area</th>
                        <th className="py-3 px-4 font-semibold text-right">Pickups</th>
                        <th className="py-3 px-4 font-semibold text-right">Weight</th>
                        <th className="py-3 px-4 font-semibold text-right">Points</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {leaderboard.map((entry, idx) => {
                        const isMe = entry.uid === profile.uid;
                        return (
                          <tr
                            key={entry.uid}
                            className={isMe ? 'bg-emerald-50/80' : 'hover:bg-[#f6faf7]/60'}
                          >
                            <td className="py-3.5 px-4 font-mono font-bold text-emerald-900 tabular-nums">
                              #{idx + 1}
                            </td>
                            <td className="py-3.5 px-4 font-medium text-slate-900">
                              {entry.name} {isMe ? '(You)' : ''}
                              <span className="block font-mono text-[11px] text-slate-500">
                                {entry.residentId}
                              </span>
                            </td>
                            <td className="py-3.5 px-4 text-xs text-slate-600">{entry.area}</td>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                              {entry.totalCollections}
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                              {entry.totalWeightKg.toFixed(1)} kg
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono font-bold text-emerald-900 tabular-nums">
                              {entry.rewardPoints.toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'notifications' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Notifications
              </h1>
              <p className="text-xs text-slate-500">
                Updates from collectors and municipal administrators
              </p>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl divide-y divide-slate-100">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No notifications yet.
                </div>
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.notificationId}
                    className={`p-5 flex items-start justify-between gap-4 ${
                      n.read ? 'bg-white' : 'bg-emerald-50/50'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <span className="font-semibold text-emerald-900">{n.title}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimestamp(n.createdAt)}</span>
                        {!n.read && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-emerald-800">Unread</span>
                          </>
                        )}
                      </div>
                      <p className="text-sm text-slate-700 leading-relaxed">{n.message}</p>
                    </div>
                    {!n.read && (
                      <button
                        type="button"
                        onClick={() => markNotificationRead(n.notificationId)}
                        className="px-3 py-1.5 rounded-lg border border-emerald-950/15 text-xs font-semibold text-emerald-900 hover:bg-emerald-100/60 transition-colors cursor-pointer shrink-0"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'profile' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Resident Profile & Settings
              </h1>
              <p className="text-xs text-slate-500">
                Manage your pickup address, contact details, and profile photo
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <form
                onSubmit={handleSaveProfile}
                className="lg:col-span-7 bg-white border border-emerald-950/10 rounded-2xl p-6 space-y-4"
              >
                <div className="flex items-center gap-4 pb-4 border-b border-slate-100">
                  {editPhoto ? (
                    <img
                      src={editPhoto}
                      alt={editName}
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                      className="w-14 h-14 rounded-2xl object-cover border border-emerald-950/10"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-2xl bg-emerald-900 text-white flex items-center justify-center font-display text-lg font-bold">
                      {profile.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="font-display font-bold text-slate-900">{profile.name}</p>
                    <p className="text-xs text-slate-500 font-mono">{profile.residentId}</p>
                  </div>
                </div>

                {profileFeedback && (
                  <div
                    className={`p-3 rounded-xl text-xs border ${
                      profileFeedback.type === 'success'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : 'bg-rose-50 border-rose-200 text-rose-800'
                    }`}
                  >
                    {profileFeedback.text}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={120}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Phone Number
                    </label>
                    <input
                      type="tel"
                      maxLength={32}
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Service Area / Zone
                  </label>
                  <select
                    value={editArea}
                    onChange={(e) => setEditArea(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm bg-white"
                  >
                    {serviceAreas.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Pickup Street Address
                  </label>
                  <input
                    type="text"
                    maxLength={300}
                    value={editAddress}
                    onChange={(e) => setEditAddress(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Profile Image URL (Optional)
                  </label>
                  <input
                    type="url"
                    maxLength={1000}
                    value={editPhoto}
                    onChange={(e) => setEditPhoto(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm"
                  />
                </div>

                <button
                  type="submit"
                  disabled={profileBusy}
                  className="px-5 py-2.5 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {profileBusy ? 'Saving...' : 'Save Profile'}
                </button>
              </form>

              {/* Collector Application Card */}
              <div className="lg:col-span-5 bg-white border border-emerald-950/10 rounded-2xl p-6">
                <h2 className="font-display text-lg font-bold text-slate-900 mb-1">
                  Apply as Field Collector
                </h2>
                <p className="text-xs text-slate-500 mb-4">
                  Municipal collectors must be approved by an administrator before gaining access to QR verification and AI waste scanning tools.
                </p>

                {collectorApp ? (
                  <div className="p-4 rounded-xl bg-[#f6faf7] border border-emerald-950/10 space-y-2 text-sm">
                    <p className="font-semibold text-slate-900 capitalize">
                      Application Status: {collectorApp.status}
                    </p>
                    <p className="text-xs text-slate-600">
                      Preferred Area: {collectorApp.preferredArea}
                    </p>
                    {collectorApp.badgeNumber && (
                      <p className="text-xs text-slate-600 font-mono">
                        Badge / ID: {collectorApp.badgeNumber}
                      </p>
                    )}
                    <p className="text-xs text-slate-500">
                      Submitted {formatTimestamp(collectorApp.createdAt)}
                    </p>
                  </div>
                ) : (
                  <form onSubmit={handleCollectorApply} className="space-y-3">
                    {appFeedback && (
                      <div
                        className={`p-3 rounded-xl text-xs border ${
                          appFeedback.type === 'success'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                            : 'bg-rose-50 border-rose-200 text-rose-800'
                        }`}
                      >
                        {appFeedback.text}
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Contact Phone
                      </label>
                      <input
                        type="tel"
                        required
                        maxLength={32}
                        value={appPhone}
                        onChange={(e) => setAppPhone(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Preferred Zone
                      </label>
                      <select
                        value={appArea}
                        onChange={(e) => setAppArea(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-sm bg-white"
                      >
                        {serviceAreas.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Employee / Route ID (Optional)
                      </label>
                      <input
                        type="text"
                        maxLength={40}
                        value={appBadge}
                        onChange={(e) => setAppBadge(e.target.value)}
                        placeholder="COL-204"
                        className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Experience / Notes
                      </label>
                      <textarea
                        rows={2}
                        maxLength={400}
                        value={appNotes}
                        onChange={(e) => setAppNotes(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-sm"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={appBusy}
                      className="w-full py-2.5 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {appBusy ? 'Submitting...' : 'Submit Collector Application'}
                    </button>
                  </form>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-emerald-950/10 grid grid-cols-5 h-16">
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
              <span className="mt-1 truncate max-w-[64px]">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
