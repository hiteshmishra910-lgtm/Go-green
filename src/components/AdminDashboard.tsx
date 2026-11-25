import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import {
  BarChart3,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Trophy,
  Users,
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
  adminAdjustRewardPoints,
  adminReviewCollectorApplication,
  adminSaveAppSettings,
  adminUpdateUserAccount,
  exportCollectionsToCsv,
  formatTimestamp,
  sendNotification,
  toDate,
} from '../lib/ecoService';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  type AccountStatus,
  type AppSettings,
  type CollectorApplication,
  DEFAULT_POINTS_BY_CATEGORY,
  DEFAULT_SERVICE_AREAS,
  type LeaderboardEntry,
  type UserProfile,
  type UserRole,
  WASTE_CATEGORIES,
  type WasteCategory,
  type WasteCollectionRecord,
} from '../types/ecoverify';

type AdminTab = 'overview' | 'collections' | 'accounts' | 'settings';

interface AdminDashboardProps {
  profile: UserProfile;
  settings: AppSettings | null;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  profile,
  settings,
}) => {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [reportPeriod, setReportPeriod] = useState<'daily' | 'weekly' | 'monthly'>('weekly');

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [collections, setCollections] = useState<WasteCollectionRecord[]>([]);
  const [applications, setApplications] = useState<CollectorApplication[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  // Collections filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [areaFilter, setAreaFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('');
  const [aiOnlyFilter, setAiOnlyFilter] = useState<'all' | 'corrected' | 'ai_only'>('all');

  // Account management state
  const [accountSearch, setAccountSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | UserRole>('all');
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Reward point adjustment modal/panel
  const [adjustTarget, setAdjustTarget] = useState<UserProfile | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('25');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustBusy, setAdjustBusy] = useState(false);

  // Notification sender
  const [notifyTarget, setNotifyTarget] = useState<UserProfile | null>(null);
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyMessage, setNotifyMessage] = useState('');
  const [notifyBusy, setNotifyBusy] = useState(false);

  // Settings editor
  const [pointsDraft, setPointsDraft] = useState<Record<WasteCategory, number>>({
    ...DEFAULT_POINTS_BY_CATEGORY,
    ...(settings?.pointsByCategory || {}),
    'Other / Unrecognized': 0,
  });
  const [areasDraft, setAreasDraft] = useState<string>(
    (settings?.serviceAreas || DEFAULT_SERVICE_AREAS).join(', ')
  );
  const [settingsBusy, setSettingsBusy] = useState(false);

  const serviceAreas = useMemo(
    () =>
      settings?.serviceAreas?.length ? settings.serviceAreas : DEFAULT_SERVICE_AREAS,
    [settings]
  );

  useEffect(() => {
    if (settings) {
      setPointsDraft({
        ...DEFAULT_POINTS_BY_CATEGORY,
        ...settings.pointsByCategory,
        'Other / Unrecognized': 0,
      });
      setAreasDraft(settings.serviceAreas.join(', '));
    }
  }, [settings]);

  useEffect(() => {
    const unsubUsers = onSnapshot(
      collection(db, 'users'),
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as UserProfile);
        rows.sort((a, b) => a.name.localeCompare(b.name));
        setUsers(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'users')
    );

    const unsubCols = onSnapshot(
      collection(db, 'collections'),
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as WasteCollectionRecord);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setCollections(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'collections')
    );

    const unsubApps = onSnapshot(
      collection(db, 'collectorApplications'),
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as CollectorApplication);
        rows.sort((a, b) => toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime());
        setApplications(rows);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'collectorApplications')
    );

    const unsubLb = onSnapshot(
      query(collection(db, 'leaderboard'), orderBy('rewardPoints', 'desc'), limit(10)),
      (snap) => {
        setLeaderboard(snap.docs.map((d) => d.data() as LeaderboardEntry));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'leaderboard')
    );

    return () => {
      unsubUsers();
      unsubCols();
      unsubApps();
      unsubLb();
    };
  }, []);

  const totalResidents = useMemo(
    () => users.filter((u) => u.role === 'resident').length,
    [users]
  );

  const activeCollectors = useMemo(
    () =>
      users.filter((u) => u.role === 'collector' && u.accountStatus === 'active').length,
    [users]
  );

  const collectedRecords = useMemo(
    () => collections.filter((c) => c.status === 'collected'),
    [collections]
  );

  const totalWasteKg = useMemo(
    () =>
      collectedRecords.reduce((sum, c) => sum + (c.weightKg || 0), 0),
    [collectedRecords]
  );

  const aiMetrics = useMemo(() => {
    const withAi = collections.filter((c) => Boolean(c.aiCategory));
    const corrected = withAi.filter((c) => c.collectorCorrected);
    const confirmed = withAi.length - corrected.length;
    const matchRate =
      withAi.length > 0 ? Math.round((confirmed / withAi.length) * 100) : 0;
    return { total: withAi.length, corrected: corrected.length, confirmed, matchRate };
  }, [collections]);

  const categoryStats = useMemo(() => {
    const map = new Map<string, { category: string; count: number; weightKg: number }>();
    for (const cat of WASTE_CATEGORIES) {
      map.set(cat, { category: cat, count: 0, weightKg: 0 });
    }
    for (const c of collectedRecords) {
      const bucket = map.get(c.category);
      if (bucket) {
        bucket.count += 1;
        bucket.weightKg = Number((bucket.weightKg + (c.weightKg || 0)).toFixed(1));
      }
    }
    return Array.from(map.values());
  }, [collectedRecords]);

  const timeSeriesReport = useMemo(() => {
    const now = new Date();
    const map = new Map<string, { label: string; weightKg: number; collections: number }>();

    if (reportPeriod === 'daily') {
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        map.set(key, {
          label: d.toLocaleDateString(undefined, { weekday: 'short' }),
          weightKg: 0,
          collections: 0,
        });
      }
      for (const c of collectedRecords) {
        const key = toDate(c.createdAt).toISOString().slice(0, 10);
        const bucket = map.get(key);
        if (bucket) {
          bucket.collections += 1;
          bucket.weightKg = Number((bucket.weightKg + (c.weightKg || 0)).toFixed(1));
        }
      }
    } else if (reportPeriod === 'weekly') {
      for (let w = 5; w >= 0; w -= 1) {
        const end = new Date(now);
        end.setDate(now.getDate() - w * 7);
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        const label = `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
        map.set(String(w), { label, weightKg: 0, collections: 0 });
      }
      for (const c of collectedRecords) {
        const diffDays = Math.floor(
          (now.getTime() - toDate(c.createdAt).getTime()) / (1000 * 60 * 60 * 24)
        );
        const weekIdx = Math.floor(diffDays / 7);
        if (weekIdx >= 0 && weekIdx <= 5) {
          const bucket = map.get(String(weekIdx));
          if (bucket) {
            bucket.collections += 1;
            bucket.weightKg = Number((bucket.weightKg + (c.weightKg || 0)).toFixed(1));
          }
        }
      }
    } else {
      for (let m = 5; m >= 0; m -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        map.set(key, {
          label: d.toLocaleString(undefined, { month: 'short' }),
          weightKg: 0,
          collections: 0,
        });
      }
      for (const c of collectedRecords) {
        const d = toDate(c.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const bucket = map.get(key);
        if (bucket) {
          bucket.collections += 1;
          bucket.weightKg = Number((bucket.weightKg + (c.weightKg || 0)).toFixed(1));
        }
      }
    }

    return Array.from(map.values());
  }, [collectedRecords, reportPeriod]);

  const areaStats = useMemo(() => {
    const map = new Map<string, { area: string; pickups: number; weightKg: number; points: number }>();
    for (const c of collectedRecords) {
      const areaName = c.area || 'Unassigned';
      const entry = map.get(areaName) || {
        area: areaName,
        pickups: 0,
        weightKg: 0,
        points: 0,
      };
      entry.pickups += 1;
      entry.weightKg = Number((entry.weightKg + (c.weightKg || 0)).toFixed(1));
      entry.points += c.pointsAwarded || 0;
      map.set(areaName, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.weightKg - a.weightKg);
  }, [collectedRecords]);

  const filteredCollections = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return collections.filter((c) => {
      if (categoryFilter !== 'all' && c.category !== categoryFilter) return false;
      if (areaFilter !== 'all' && c.area !== areaFilter) return false;
      if (dateFilter) {
        const recDate = toDate(c.createdAt).toISOString().slice(0, 10);
        if (recDate !== dateFilter) return false;
      }
      if (aiOnlyFilter === 'corrected' && !c.collectorCorrected) return false;
      if (aiOnlyFilter === 'ai_only' && !c.aiCategory) return false;
      if (q) {
        const hay = `${c.residentName} ${c.residentId} ${c.collectorName} ${c.area} ${c.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [collections, searchTerm, categoryFilter, areaFilter, dateFilter, aiOnlyFilter]);

  const filteredUsers = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (q) {
        const hay = `${u.name} ${u.email} ${u.residentId} ${u.area || ''} ${u.assignedArea || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [users, accountSearch, roleFilter]);

  const pendingApps = useMemo(
    () => applications.filter((a) => a.status === 'pending'),
    [applications]
  );

  const handleRoleChange = async (target: UserProfile, role: UserRole) => {
    setActionFeedback(null);
    try {
      await adminUpdateUserAccount(profile, target, { role });
      setActionFeedback({
        type: 'success',
        text: `Updated ${target.name}'s role to ${role}.`,
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update role.',
      });
    }
  };

  const handleStatusChange = async (target: UserProfile, accountStatus: AccountStatus) => {
    setActionFeedback(null);
    try {
      await adminUpdateUserAccount(profile, target, { accountStatus });
      setActionFeedback({
        type: 'success',
        text: `Set ${target.name}'s account status to ${accountStatus}.`,
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update status.',
      });
    }
  };

  const handleAssignedAreaChange = async (target: UserProfile, assignedArea: string) => {
    setActionFeedback(null);
    try {
      await adminUpdateUserAccount(profile, target, { assignedArea });
      setActionFeedback({
        type: 'success',
        text: `Assigned ${target.name} to ${assignedArea}.`,
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to assign area.',
      });
    }
  };

  const handleApplicationDecision = async (
    app: CollectorApplication,
    decision: 'approved' | 'rejected'
  ) => {
    setActionFeedback(null);
    try {
      await adminReviewCollectorApplication(profile, app, decision, app.preferredArea);
      setActionFeedback({
        type: 'success',
        text: `Collector application for ${app.name} ${decision}.`,
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to review application.',
      });
    }
  };

  const handleAdjustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustTarget) return;
    setAdjustBusy(true);
    setActionFeedback(null);
    try {
      await adminAdjustRewardPoints(
        profile,
        adjustTarget,
        Number(adjustDelta),
        adjustReason
      );
      setActionFeedback({
        type: 'success',
        text: `Adjusted ${adjustTarget.name}'s points by ${adjustDelta} with audit log.`,
      });
      setAdjustTarget(null);
      setAdjustReason('');
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to adjust points.',
      });
    } finally {
      setAdjustBusy(false);
    }
  };

  const handleNotifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notifyTarget) return;
    setNotifyBusy(true);
    setActionFeedback(null);
    try {
      await sendNotification(profile, notifyTarget.uid, {
        type: 'area_notice',
        title: notifyTitle,
        message: notifyMessage,
      });
      setActionFeedback({
        type: 'success',
        text: `Sent notification to ${notifyTarget.name}.`,
      });
      setNotifyTarget(null);
      setNotifyTitle('');
      setNotifyMessage('');
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to send notification.',
      });
    } finally {
      setNotifyBusy(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsBusy(true);
    setActionFeedback(null);
    try {
      const parsedAreas = areasDraft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await adminSaveAppSettings(profile, pointsDraft, parsedAreas);
      setActionFeedback({
        type: 'success',
        text: 'Saved reward point schedule and municipal service areas.',
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save settings.',
      });
    } finally {
      setSettingsBusy(false);
    }
  };

  const navItems: { id: AdminTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'overview', label: 'Analytics', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'collections', label: 'Collections & AI', icon: <FileSpreadsheet className="w-4 h-4" /> },
    {
      id: 'accounts',
      label: 'Users & Roles',
      icon: <Users className="w-4 h-4" />,
      badge: pendingApps.length > 0 ? pendingApps.length : undefined,
    },
    { id: 'settings', label: 'Rewards & Areas', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <div className="flex flex-1 min-h-0">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 shrink-0 bg-white border-r border-emerald-950/10 p-4 justify-between">
        <div className="space-y-1">
          <p className="px-3 py-2 text-xs font-semibold text-slate-400">
            Municipal Admin
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
                      active ? 'text-emerald-200' : 'text-amber-700 font-semibold'
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
          <p className="text-xs text-slate-500 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-800" />
            Verified Administrator
          </p>
          <p className="text-xs text-slate-600 truncate mt-1">{profile.email}</p>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 pb-24 lg:pb-10 max-w-7xl mx-auto w-full">
        {actionFeedback && (
          <div
            className={`mb-6 p-4 rounded-2xl border text-sm ${
              actionFeedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            {actionFeedback.text}
          </div>
        )}

        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500">Municipal Waste Operations Console</p>
                <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
                  City Sustainability Overview
                </h1>
              </div>

              <button
                type="button"
                onClick={() => exportCollectionsToCsv(filteredCollections)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 transition-colors cursor-pointer self-start sm:self-auto"
              >
                <Download className="w-4 h-4" />
                Download CSV Report ({filteredCollections.length})
              </button>
            </div>

            {/* 4 KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Registered Residents</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
                  {totalResidents}
                </p>
                <p className="text-xs text-slate-500 mt-1">{users.length} total accounts</p>
              </div>
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Active Collectors</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-emerald-900 tabular-nums">
                  {activeCollectors}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {pendingApps.length} pending applications
                </p>
              </div>
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">Total Waste Collected</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
                  {totalWasteKg.toFixed(1)} kg
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {collectedRecords.length} verified pickups
                </p>
              </div>
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
                <p className="text-xs text-slate-500 mb-1">AI Agreement Rate</p>
                <p className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tabular-nums">
                  {aiMetrics.total > 0 ? `${aiMetrics.matchRate}%` : '—'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {aiMetrics.corrected} collector corrections / {aiMetrics.total} scans
                </p>
              </div>
            </div>

            {/* Reports Row */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7 bg-white border border-emerald-950/10 rounded-2xl p-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 className="font-display text-lg font-bold text-slate-900">
                      Collection Volume Report
                    </h2>
                    <p className="text-xs text-slate-500">
                      Verified weight (kg) and pickup count by time period
                    </p>
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-[#f6faf7] border border-emerald-950/10 rounded-xl self-start">
                    {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setReportPeriod(p)}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-lg capitalize cursor-pointer ${
                          reportPeriod === p
                            ? 'bg-emerald-900 text-white'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={timeSeriesReport}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#475569' }} />
                      <YAxis tick={{ fontSize: 12, fill: '#475569' }} />
                      <Tooltip />
                      <Bar dataKey="weightKg" name="Weight (kg)" fill="#14532d" radius={[6, 6, 0, 0]} />
                      <Bar dataKey="collections" name="Pickups" fill="#10b981" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="lg:col-span-5 bg-white border border-emerald-950/10 rounded-2xl p-6">
                <h2 className="font-display text-lg font-bold text-slate-900 mb-1">
                  Category-Wise Waste (kg)
                </h2>
                <p className="text-xs text-slate-500 mb-4">
                  Across all 7 supported waste categories
                </p>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={categoryStats} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis type="number" tick={{ fontSize: 11, fill: '#475569' }} />
                      <YAxis
                        dataKey="category"
                        type="category"
                        width={100}
                        tick={{ fontSize: 11, fill: '#475569' }}
                      />
                      <Tooltip />
                      <Bar dataKey="weightKg" name="Weight (kg)" fill="#059669" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Area-Wise Reports & Top Leaderboard */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7 bg-white border border-emerald-950/10 rounded-2xl p-6">
                <h2 className="font-display text-lg font-bold text-slate-900 mb-1">
                  Area-Wise Collection Report
                </h2>
                <p className="text-xs text-slate-500 mb-4">
                  Performance breakdown by municipal collection zone
                </p>
                {areaStats.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4">No completed collections yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 text-xs text-slate-500">
                          <th className="py-2.5 font-semibold">Area / Zone</th>
                          <th className="py-2.5 font-semibold text-right">Pickups</th>
                          <th className="py-2.5 font-semibold text-right">Weight</th>
                          <th className="py-2.5 font-semibold text-right">Points Issued</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {areaStats.map((a) => (
                          <tr key={a.area}>
                            <td className="py-2.5 font-medium text-slate-900">{a.area}</td>
                            <td className="py-2.5 text-right font-mono tabular-nums">{a.pickups}</td>
                            <td className="py-2.5 text-right font-mono tabular-nums">
                              {a.weightKg.toFixed(1)} kg
                            </td>
                            <td className="py-2.5 text-right font-mono tabular-nums text-emerald-800 font-semibold">
                              {a.points.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="lg:col-span-5 bg-white border border-emerald-950/10 rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Trophy className="w-5 h-5 text-emerald-800" />
                  <h2 className="font-display text-lg font-bold text-slate-900">
                    Top Residents Leaderboard
                  </h2>
                </div>
                {leaderboard.length === 0 ? (
                  <p className="text-sm text-slate-500">No leaderboard entries yet.</p>
                ) : (
                  <div className="divide-y divide-slate-100 text-sm">
                    {leaderboard.map((entry, idx) => (
                      <div key={entry.uid} className="py-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">
                            <span className="font-mono text-emerald-900 mr-2">#{idx + 1}</span>
                            {entry.name}
                          </p>
                          <p className="text-xs text-slate-500 truncate">
                            {entry.residentId} · {entry.area}
                          </p>
                        </div>
                        <span className="font-mono font-bold text-emerald-900 tabular-nums shrink-0">
                          {entry.rewardPoints} pts
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'collections' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-slate-900">
                  All Collection Records & AI Classification Audit
                </h1>
                <p className="text-xs text-slate-500">
                  Filter by resident, collector, date, area, category, or AI corrections
                </p>
              </div>
              <button
                type="button"
                onClick={() => exportCollectionsToCsv(filteredCollections)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer self-start sm:self-auto"
              >
                <Download className="w-4 h-4" />
                Export Filtered CSV
              </button>
            </div>

            {/* Filters Bar */}
            <div className="bg-white border border-emerald-950/10 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Resident, ID, or collector..."
                  className="w-full pl-9 pr-3 py-2 rounded-xl border border-emerald-950/15 text-xs"
                />
              </div>

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-emerald-950/15 text-xs bg-white"
              >
                <option value="all">All Categories</option>
                {WASTE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <select
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-emerald-950/15 text-xs bg-white"
              >
                <option value="all">All Areas</option>
                {serviceAreas.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>

              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-emerald-950/15 text-xs"
              />

              <select
                value={aiOnlyFilter}
                onChange={(e) => setAiOnlyFilter(e.target.value as 'all' | 'corrected' | 'ai_only')}
                className="px-3 py-2 rounded-xl border border-emerald-950/15 text-xs bg-white"
              >
                <option value="all">All Records</option>
                <option value="ai_only">AI Scanned Only</option>
                <option value="corrected">AI Corrected Only</option>
              </select>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl overflow-hidden">
              {filteredCollections.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No collection records match the selected filters.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-xs text-slate-500 bg-[#f6faf7]">
                        <th className="py-3 px-4 font-semibold">Date</th>
                        <th className="py-3 px-4 font-semibold">Resident</th>
                        <th className="py-3 px-4 font-semibold">Collector & Area</th>
                        <th className="py-3 px-4 font-semibold">Final Category</th>
                        <th className="py-3 px-4 font-semibold">AI Prediction</th>
                        <th className="py-3 px-4 font-semibold">Status</th>
                        <th className="py-3 px-4 font-semibold text-right">Weight</th>
                        <th className="py-3 px-4 font-semibold text-right">Points</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredCollections.map((r) => (
                        <tr key={r.collectionId} className="hover:bg-[#f6faf7]/60">
                          <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap">
                            {formatTimestamp(r.createdAt)}
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-medium text-slate-900">{r.residentName}</span>
                            <span className="block font-mono text-[11px] text-slate-500">
                              {r.residentId}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">
                            <span className="font-medium text-slate-800 block">
                              {r.collectorName || 'Unassigned'}
                            </span>
                            {r.area}
                          </td>
                          <td className="py-3 px-4 font-medium text-slate-900">{r.category}</td>
                          <td className="py-3 px-4 text-xs">
                            {r.aiCategory ? (
                              <div>
                                <span className="text-slate-800 font-medium">
                                  {r.aiCategory} (~{r.aiConfidence ?? 0}%)
                                </span>
                                {r.collectorCorrected && (
                                  <span className="block text-amber-700 font-semibold">
                                    Collector Corrected
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-400">No AI scan</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-xs font-semibold capitalize">
                            {r.status === 'collected' ? (
                              <span className="text-emerald-800">Collected</span>
                            ) : r.status === 'rejected' ? (
                              <span className="text-rose-700">Rejected</span>
                            ) : (
                              <span className="text-amber-700">Pending</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums">
                            {r.weightKg.toFixed(1)} kg
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-emerald-800">
                            +{r.pointsAwarded}
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

        {tab === 'accounts' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Residents, Collectors & Role Management
              </h1>
              <p className="text-xs text-slate-500">
                Approve collector applications, assign service areas, suspend accounts, or issue audited reward adjustments
              </p>
            </div>

            {/* Pending Collector Applications */}
            {pendingApps.length > 0 && (
              <div className="bg-white border border-emerald-950/10 rounded-2xl p-6 space-y-4">
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Pending Collector Applications ({pendingApps.length})
                </h2>
                <div className="divide-y divide-slate-100">
                  {pendingApps.map((app) => (
                    <div
                      key={app.uid}
                      className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                    >
                      <div className="space-y-1">
                        <p className="font-semibold text-slate-900">
                          {app.name} · <span className="text-xs text-slate-500">{app.email}</span>
                        </p>
                        <p className="text-xs text-slate-600">
                          Preferred Zone: {app.preferredArea} · Phone: {app.phone}
                          {app.badgeNumber ? ` · Badge: ${app.badgeNumber}` : ''}
                        </p>
                        {app.notes && <p className="text-xs text-slate-500">{app.notes}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleApplicationDecision(app, 'approved')}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Approve Collector
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApplicationDecision(app, 'rejected')}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-rose-200 text-rose-700 text-xs font-semibold hover:bg-rose-50 cursor-pointer"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Adjust Points Modal/Drawer Inline */}
            {adjustTarget && (
              <form
                onSubmit={handleAdjustSubmit}
                className="bg-white border border-emerald-900/30 rounded-2xl p-6 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-base font-bold text-slate-900">
                    Adjust Reward Points for {adjustTarget.name} ({adjustTarget.residentId})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setAdjustTarget(null)}
                    className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                <p className="text-xs text-slate-600">
                  Current balance: <span className="font-mono font-bold">{adjustTarget.rewardPoints} pts</span>. Creates an immutable audit record in Firestore.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Points Delta (+/-)
                    </label>
                    <input
                      type="number"
                      required
                      value={adjustDelta}
                      onChange={(e) => setAdjustDelta(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-sm font-mono tabular-nums"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Mandatory Audit Reason
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={300}
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="e.g., Community cleanup drive bonus or duplicate entry correction"
                      className="w-full px-3 py-2 rounded-xl border border-emerald-950/15 text-sm"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={adjustBusy}
                  className="px-4 py-2 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer disabled:opacity-50"
                >
                  {adjustBusy ? 'Recording...' : 'Confirm Audited Adjustment'}
                </button>
              </form>
            )}

            {/* Send Notification Panel */}
            {notifyTarget && (
              <form
                onSubmit={handleNotifySubmit}
                className="bg-white border border-emerald-900/30 rounded-2xl p-6 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-base font-bold text-slate-900">
                    Send Notification to {notifyTarget.name}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setNotifyTarget(null)}
                    className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    maxLength={140}
                    value={notifyTitle}
                    onChange={(e) => setNotifyTitle(e.target.value)}
                    placeholder="Notification subject"
                    className="px-3 py-2 rounded-xl border border-emerald-950/15 text-sm"
                  />
                  <input
                    type="text"
                    required
                    maxLength={600}
                    value={notifyMessage}
                    onChange={(e) => setNotifyMessage(e.target.value)}
                    placeholder="Message body"
                    className="px-3 py-2 rounded-xl border border-emerald-950/15 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={notifyBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-900 text-white text-xs font-semibold hover:bg-emerald-800 cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  {notifyBusy ? 'Sending...' : 'Send Notification'}
                </button>
              </form>
            )}

            {/* Users Filter & Table */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder="Search by name, email, Resident ID, or area..."
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 bg-white text-sm"
                />
              </div>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as 'all' | UserRole)}
                className="px-3 py-2.5 rounded-xl border border-emerald-950/15 bg-white text-sm"
              >
                <option value="all">All Roles</option>
                <option value="resident">Residents</option>
                <option value="collector">Collectors</option>
                <option value="admin">Admins</option>
              </select>
            </div>

            <div className="bg-white border border-emerald-950/10 rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs text-slate-500 bg-[#f6faf7]">
                      <th className="py-3 px-4 font-semibold">Account</th>
                      <th className="py-3 px-4 font-semibold">Role</th>
                      <th className="py-3 px-4 font-semibold">Status</th>
                      <th className="py-3 px-4 font-semibold">Assigned Area</th>
                      <th className="py-3 px-4 font-semibold text-right">Points</th>
                      <th className="py-3 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredUsers.map((u) => (
                      <tr key={u.uid} className="hover:bg-[#f6faf7]/60">
                        <td className="py-3 px-4">
                          <span className="font-medium text-slate-900 block">{u.name}</span>
                          <span className="text-xs text-slate-500">
                            {u.email} · <span className="font-mono">{u.residentId}</span>
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <select
                            value={u.role}
                            disabled={u.uid === profile.uid}
                            onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-950/15 text-xs bg-white disabled:opacity-60"
                          >
                            <option value="resident">Resident</option>
                            <option value="collector">Collector</option>
                            <option value="admin">Admin</option>
                          </select>
                        </td>
                        <td className="py-3 px-4">
                          <select
                            value={u.accountStatus}
                            disabled={u.uid === profile.uid}
                            onChange={(e) =>
                              handleStatusChange(u, e.target.value as AccountStatus)
                            }
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-950/15 text-xs bg-white disabled:opacity-60"
                          >
                            <option value="active">Active</option>
                            <option value="pending">Pending</option>
                            <option value="suspended">Suspended</option>
                            <option value="deactivated">Deactivated</option>
                          </select>
                        </td>
                        <td className="py-3 px-4">
                          <select
                            value={u.assignedArea || u.area || serviceAreas[0]}
                            onChange={(e) => handleAssignedAreaChange(u, e.target.value)}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-950/15 text-xs bg-white max-w-[170px]"
                          >
                            {serviceAreas.map((a) => (
                              <option key={a} value={a}>
                                {a}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-emerald-900 tabular-nums">
                          {u.rewardPoints.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap space-x-2">
                          <button
                            type="button"
                            onClick={() => setAdjustTarget(u)}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-950/15 text-xs font-semibold text-emerald-900 hover:bg-emerald-50 cursor-pointer"
                          >
                            Points
                          </button>
                          <button
                            type="button"
                            onClick={() => setNotifyTarget(u)}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-950/15 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                          >
                            Notify
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'settings' && (
          <div className="space-y-6">
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Reward Rules & Municipal Zones
              </h1>
              <p className="text-xs text-slate-500">
                Configure point rewards awarded per verified waste category and active service areas
              </p>
            </div>

            <form
              onSubmit={handleSaveSettings}
              className="bg-white border border-emerald-950/10 rounded-2xl p-6 space-y-6 max-w-3xl"
            >
              <div>
                <h2 className="font-display text-base font-bold text-slate-900 mb-3">
                  Points Awarded Per Verified Collection
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {WASTE_CATEGORIES.map((cat) => (
                    <div
                      key={cat}
                      className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#f6faf7] border border-emerald-950/10"
                    >
                      <span className="text-sm font-medium text-slate-800">{cat}</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        disabled={cat === 'Other / Unrecognized'}
                        value={
                          cat === 'Other / Unrecognized'
                            ? 0
                            : (pointsDraft[cat] ?? DEFAULT_POINTS_BY_CATEGORY[cat] ?? 10)
                        }
                        onChange={(e) =>
                          setPointsDraft((prev) => ({
                            ...prev,
                            [cat]: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                          }))
                        }
                        className="w-20 px-2.5 py-1.5 rounded-lg border border-emerald-950/15 bg-white text-right font-mono text-sm tabular-nums disabled:bg-slate-100 disabled:text-slate-400"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-900 mb-1">
                  Municipal Service Areas (Comma-Separated)
                </label>
                <p className="text-xs text-slate-500 mb-2">
                  Used for resident registration, collector assignments, and area-wise reports.
                </p>
                <textarea
                  rows={3}
                  value={areasDraft}
                  onChange={(e) => setAreasDraft(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={settingsBusy}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                {settingsBusy ? 'Saving Configuration...' : 'Save Platform Settings'}
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Mobile Bottom Navigation */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-emerald-950/10 grid grid-cols-4 h-16">
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
              <span className="mt-1 truncate max-w-[72px]">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
