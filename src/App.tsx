import React, { useEffect, useRef, useState } from 'react';
import {
  onAuthStateChanged,
  sendEmailVerification,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import {
  Loader2,
  LogOut,
  MailCheck,
  Recycle,
  RefreshCw,
} from 'lucide-react';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthScreen } from './components/AuthScreen';
import { CollectorDashboard } from './components/CollectorDashboard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ResidentDashboard } from './components/ResidentDashboard';
import { ensureUserProfile } from './lib/ecoService';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  testConnection,
} from './lib/firebase';
import {
  type AppSettings,
  type UserProfile,
  type UserRole,
} from './types/ecoverify';

function EcoVerifyShell() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [offlineWarning, setOfflineWarning] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [adminViewMode, setAdminViewMode] = useState<UserRole>('admin');
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  const pendingDefaultsRef = useRef<{
    name?: string;
    phone?: string;
    address?: string;
    area?: string;
  }>({});

  useEffect(() => {
    testConnection().then((res) => {
      if (res.offline) setOfflineWarning(true);
    });
  }, []);

  useEffect(() => {
    let unsubProfile: (() => void) | null = null;
    let unsubSettings: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (unsubProfile) {
        unsubProfile();
        unsubProfile = null;
      }
      if (unsubSettings) {
        unsubSettings();
        unsubSettings = null;
      }

      setFirebaseUser(user);
      setProfile(null);
      setProfileError(null);

      if (!user) {
        setAuthReady(true);
        return;
      }

      if (!user.emailVerified) {
        setAuthReady(true);
        return;
      }

      try {
        const initialized = await ensureUserProfile(user, pendingDefaultsRef.current);
        pendingDefaultsRef.current = {};
        setProfile(initialized);
        setAdminViewMode(initialized.role);

        unsubProfile = onSnapshot(
          doc(db, 'users', user.uid),
          (snap) => {
            if (snap.exists()) {
              setProfile(snap.data() as UserProfile);
            }
          },
          (err) => handleFirestoreError(err, OperationType.GET, `users/${user.uid}`)
        );

        unsubSettings = onSnapshot(
          doc(db, 'settings', 'app'),
          (snap) => {
            if (snap.exists()) {
              setSettings(snap.data() as AppSettings);
            }
          },
          () => {
            // Non-blocking fallback to default settings if settings/app not created yet
          }
        );
      } catch (err) {
        setProfileError(
          err instanceof Error ? err.message : 'Unable to initialize your EcoVerify profile.'
        );
      } finally {
        setAuthReady(true);
      }
    });

    return () => {
      unsubAuth();
      if (unsubProfile) unsubProfile();
      if (unsubSettings) unsubSettings();
    };
  }, []);

  const handleRefreshVerification = async () => {
    if (!auth.currentUser) return;
    setVerifyBusy(true);
    setVerifyNotice(null);
    try {
      await auth.currentUser.reload();
      if (auth.currentUser.emailVerified) {
        const initialized = await ensureUserProfile(
          auth.currentUser,
          pendingDefaultsRef.current
        );
        pendingDefaultsRef.current = {};
        setProfile(initialized);
        setAdminViewMode(initialized.role);
        window.location.reload();
      } else {
        setVerifyNotice('Email is not verified yet. Please click the verification link in your inbox.');
      }
    } catch (err) {
      setVerifyNotice(err instanceof Error ? err.message : 'Could not refresh status.');
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleResendVerification = async () => {
    if (!auth.currentUser) return;
    setVerifyBusy(true);
    setVerifyNotice(null);
    try {
      await sendEmailVerification(auth.currentUser);
      setVerifyNotice(`Verification email sent to ${auth.currentUser.email}.`);
    } catch (err) {
      setVerifyNotice(err instanceof Error ? err.message : 'Unable to resend email right now.');
    } finally {
      setVerifyBusy(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#f6faf7] flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-emerald-900 font-medium text-sm">
          <Loader2 className="w-5 h-5 animate-spin" />
          Connecting to EcoVerify...
        </div>
      </div>
    );
  }

  if (!firebaseUser) {
    return (
      <AuthScreen
        onPendingProfileDefaults={(defaults) => {
          pendingDefaultsRef.current = defaults;
        }}
        offlineWarning={offlineWarning}
      />
    );
  }

  if (!firebaseUser.emailVerified) {
    return (
      <div className="min-h-screen bg-[#f6faf7] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-emerald-950/10 rounded-2xl p-8 space-y-5 shadow-sm">
          <div className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-900 flex items-center justify-center">
            <MailCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-slate-900 mb-1">
              Verify Your Email Address
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed">
              We sent a verification link to <span className="font-semibold text-slate-900">{firebaseUser.email}</span>. Verify your email before accessing EcoVerify dashboards.
            </p>
          </div>
          {verifyNotice && (
            <p className="text-xs bg-[#f6faf7] border border-emerald-950/10 rounded-xl p-3 text-emerald-950">
              {verifyNotice}
            </p>
          )}
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={handleRefreshVerification}
              disabled={verifyBusy}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className="w-4 h-4" />
              I&apos;ve Verified — Continue
            </button>
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={verifyBusy}
              className="w-full py-2.5 px-4 rounded-xl border border-emerald-950/15 bg-white text-slate-800 text-sm font-semibold hover:bg-[#f6faf7] cursor-pointer disabled:opacity-50"
            >
              Resend Verification Email
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full py-2 text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              Sign out and use another account
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="min-h-screen bg-[#f6faf7] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-rose-200 rounded-2xl p-6 space-y-4">
          <h1 className="font-display text-lg font-bold text-rose-800">
            Account Initialization Error
          </h1>
          <p className="text-sm text-slate-600">{profileError}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl bg-emerald-900 text-white text-xs font-semibold cursor-pointer"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-[#f6faf7] flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-emerald-900 font-medium text-sm">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading EcoVerify workspace...
        </div>
      </div>
    );
  }

  const effectiveRole: UserRole =
    profile.role === 'admin' ? adminViewMode : profile.role;

  return (
    <div className="min-h-screen bg-[#f6faf7] flex flex-col">
      {/* Top Bar Contract: 3 zones */}
      <header className="sticky top-0 z-30 bg-white border-b border-emerald-950/10 px-4 sm:px-6 h-16 flex items-center justify-between gap-4 sm:gap-8">
        {/* Zone 1: Brand wordmark */}
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-900 text-white flex items-center justify-center">
            <Recycle className="w-4 h-4" />
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-slate-900">
            EcoVerify
          </span>
        </div>

        {/* Zone 2: Role Context or Admin Workspace Switcher */}
        <div className="flex items-center gap-3 min-w-0">
          {profile.role === 'admin' ? (
            <div className="flex items-center gap-1 p-1 bg-[#f6faf7] border border-emerald-950/10 rounded-xl">
              {(['admin', 'collector', 'resident'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setAdminViewMode(r)}
                  className={`px-3 py-1 text-xs font-semibold rounded-lg capitalize transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    adminViewMode === r
                      ? 'bg-emerald-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          ) : (
            <span className="text-xs sm:text-sm font-medium text-slate-600 capitalize truncate">
              {profile.role} Dashboard
            </span>
          )}
        </div>

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-950/15 bg-white hover:bg-[#f6faf7] text-xs font-semibold text-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {effectiveRole === 'admin' && (
        <AdminDashboard profile={profile} settings={settings} />
      )}
      {effectiveRole === 'collector' && (
        <CollectorDashboard profile={profile} settings={settings} />
      )}
      {effectiveRole === 'resident' && (
        <ResidentDashboard profile={profile} settings={settings} />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <EcoVerifyShell />
    </ErrorBoundary>
  );
}
