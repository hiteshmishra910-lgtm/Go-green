import React, { useState } from 'react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  Leaf,
  Lock,
  Mail,
  MapPin,
  Phone,
  Recycle,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { auth, googleProvider } from '../lib/firebase';
import { DEFAULT_SERVICE_AREAS } from '../types/ecoverify';

interface AuthScreenProps {
  onPendingProfileDefaults: (defaults: {
    name?: string;
    phone?: string;
    address?: string;
    area?: string;
  }) => void;
  offlineWarning?: boolean;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  onPendingProfileDefaults,
  offlineWarning,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState(DEFAULT_SERVICE_AREAS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [heroImgFailed, setHeroImgFailed] = useState(false);

  const mapAuthError = (err: unknown): string => {
    const code = (err as { code?: string })?.code || '';
    const msg = err instanceof Error ? err.message : String(err);

    if (code === 'auth/operation-not-allowed') {
      return 'Email/Password sign-in is not yet enabled in Firebase Console (Authentication → Sign-in method → Email/Password). You can use Google Sign-In immediately or enable Email/Password in Firebase Console.';
    }
    if (code === 'auth/email-already-in-use') {
      return 'An account with this email already exists. Please sign in instead.';
    }
    if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
      return 'Incorrect email or password. Please check your credentials and try again.';
    }
    if (code === 'auth/weak-password') {
      return 'Password must be at least 6 characters long.';
    }
    if (code === 'auth/popup-closed-by-user') {
      return 'Google sign-in popup was closed before completing.';
    }
    if (code === 'auth/popup-blocked') {
      return 'Popup was blocked by your browser. Please allow popups for this site and retry.';
    }
    return msg;
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);

    try {
      if (mode === 'reset') {
        await sendPasswordResetEmail(auth, email.trim());
        setInfoMessage('Password reset instructions have been sent to your email address.');
        setLoading(false);
        return;
      }

      if (mode === 'register') {
        if (!name.trim()) {
          throw new Error('Full name is required to register.');
        }
        onPendingProfileDefaults({
          name: name.trim(),
          phone: phone.trim(),
          address: address.trim(),
          area,
        });
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(cred.user, { displayName: name.trim() });
        await sendEmailVerification(cred.user);
        setInfoMessage(
          'Account created! Please check your inbox and verify your email address before activating your dashboard.'
        );
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (err) {
      setError(mapAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f6faf7] flex flex-col">
      {/* Top Bar Contract: 3 zones */}
      <header className="bg-white border-b border-emerald-950/10 px-6 lg:px-10 h-16 flex items-center justify-between gap-8">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-900 text-white flex items-center justify-center">
            <Recycle className="w-4 h-4" />
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-slate-900">
            EcoVerify
          </span>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#workflow" className="hover:text-emerald-900 transition-colors whitespace-nowrap shrink-0">
            AI Classification
          </a>
          <a href="#roles" className="hover:text-emerald-900 transition-colors whitespace-nowrap shrink-0">
            Resident & Collector
          </a>
          <a href="#rewards" className="hover:text-emerald-900 transition-colors whitespace-nowrap shrink-0">
            Reward Ledger
          </a>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="px-4 py-2 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            Sign In with Google
          </button>
        </div>
      </header>

      {offlineWarning && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 text-xs text-amber-900 flex items-center justify-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            Firestore connection check detected an offline state. Verify your network and Firebase configuration.
          </span>
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10 lg:py-14 grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
        {/* Left Showcase Column */}
        <section className="lg:col-span-7 flex flex-col justify-between gap-8">
          <div>
            <p className="text-xs font-semibold text-emerald-800 tracking-wide mb-3">
              Municipal Circular Economy · Verified Waste Tracking
            </p>
            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-slate-900 leading-[1.12] max-w-2xl [text-wrap:balance] mb-4">
              Verified waste sorting powered by visual AI and QR accountability.
            </h1>
            <p className="text-base text-slate-600 max-w-xl leading-relaxed">
              EcoVerify connects households, municipal field collectors, and city administrators on one transparent sustainability ledger. Scan resident passes, verify sorted materials with Gemini vision, and credit real reward points.
            </p>
          </div>

          <div className="relative rounded-2xl overflow-hidden border border-emerald-950/10 bg-emerald-950 aspect-[16/9]">
            {!heroImgFailed ? (
              <img
                src="/src/assets/images/hero_ecoverify_hub_1795545520299.jpg"
                alt="Sunlit modern civic recycling and urban sustainability pavilion"
                referrerPolicy="no-referrer"
                onError={() => setHeroImgFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-emerald-950 via-emerald-900 to-emerald-800 text-emerald-50 p-8 text-center">
                <Leaf className="w-12 h-12 mb-3 opacity-80" />
                <p className="font-display text-lg font-semibold">EcoVerify Municipal Sorting Hub</p>
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent flex items-end p-6">
              <div className="text-white">
                <p className="text-xs text-emerald-200 font-medium mb-1">
                  Resident QR Pass · Collector AI Scanner · Municipal Audit Trail
                </p>
                <p className="text-sm sm:text-base font-medium max-w-xl">
                  Eight waste streams verified on-site before reward points are committed to Firestore.
                </p>
              </div>
            </div>
          </div>

          <div id="workflow" className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div id="roles" className="bg-white border border-emerald-950/10 rounded-2xl p-5">
              <Recycle className="w-5 h-5 text-emerald-800 mb-3" />
              <h2 className="font-display text-sm font-bold text-slate-900 mb-1">
                Resident QR Pass
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                Every resident receives a unique non-sensitive QR ID, pickup tracker, and leaderboard rank.
              </p>
            </div>
            <div className="bg-white border border-emerald-950/10 rounded-2xl p-5">
              <ShieldCheck className="w-5 h-5 text-emerald-800 mb-3" />
              <h2 className="font-display text-sm font-bold text-slate-900 mb-1">
                Collector AI Scanner
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                Rear-camera waste capture analyzed server-side by Gemini with human confirmation and overrides.
              </p>
            </div>
            <div id="rewards" className="bg-white border border-emerald-950/10 rounded-2xl p-5">
              <Leaf className="w-5 h-5 text-emerald-800 mb-3" />
              <h2 className="font-display text-sm font-bold text-slate-900 mb-1">
                Role-Protected Ledger
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                Firestore rules isolate PII and enforce atomic, duplicate-proof reward transactions.
              </p>
            </div>
          </div>
        </section>

        {/* Right Authentication Card */}
        <section className="lg:col-span-5 flex flex-col justify-center">
          <div className="bg-white border border-emerald-950/10 rounded-2xl p-6 sm:p-8 shadow-sm">
            <div className="flex items-center gap-1 p-1 bg-[#f6faf7] border border-emerald-950/10 rounded-xl mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                  setInfoMessage(null);
                }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                  mode === 'login'
                    ? 'bg-white text-emerald-950 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                  setInfoMessage(null);
                }}
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                  mode === 'register'
                    ? 'bg-white text-emerald-950 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Register Resident
              </button>
            </div>

            <h2 className="font-display text-xl font-bold text-slate-900 mb-1">
              {mode === 'login'
                ? 'Access Your EcoVerify Account'
                : mode === 'register'
                  ? 'Create Resident Account'
                  : 'Reset Password'}
            </h2>
            <p className="text-xs text-slate-500 mb-5">
              {mode === 'login'
                ? 'Residents, collectors, and verified administrators sign in here.'
                : mode === 'register'
                  ? 'New accounts start as verified residents. Collector roles are assigned by municipal admins.'
                  : 'Enter your registered email to receive a password reset link.'}
            </p>

            {error && (
              <div className="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{error}</span>
              </div>
            )}

            {infoMessage && (
              <div className="mb-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{infoMessage}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-xl border border-emerald-950/15 bg-white hover:bg-[#f6faf7] text-slate-900 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-60 mb-5"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-8.97Z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                />
              </svg>
              Continue with Google
            </button>

            <div className="relative flex items-center mb-5">
              <div className="flex-1 border-t border-emerald-950/10" />
              <span className="px-3 text-xs text-slate-400">or with email</span>
              <div className="flex-1 border-t border-emerald-950/10" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-3.5">
              {mode === 'register' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Full Name
                    </label>
                    <div className="relative">
                      <UserIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        required
                        maxLength={120}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Aarav Sharma"
                        className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Phone Number
                      </label>
                      <div className="relative">
                        <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="tel"
                          maxLength={32}
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="+1 555 014 8821"
                          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Service Area
                      </label>
                      <select
                        value={area}
                        onChange={(e) => setArea(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      >
                        {DEFAULT_SERVICE_AREAS.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Pickup Street Address
                    </label>
                    <div className="relative">
                      <MapPin className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        maxLength={300}
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="42 Cedar Grove Lane, Apt 3B"
                        className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="resident@example.com"
                    className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>
              </div>

              {mode !== 'reset' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-700">
                      Password
                    </label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('reset');
                          setError(null);
                          setInfoMessage(null);
                        }}
                        className="text-xs font-medium text-emerald-800 hover:underline cursor-pointer"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 6 characters"
                      className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-emerald-950/15 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-900 text-white text-sm font-semibold hover:bg-emerald-800 transition-colors cursor-pointer disabled:opacity-60 mt-2"
              >
                {loading
                  ? 'Please wait...'
                  : mode === 'login'
                    ? 'Sign In'
                    : mode === 'register'
                      ? 'Create Resident Account'
                      : 'Send Reset Link'}
              </button>

              {mode === 'reset' && (
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="w-full text-center text-xs font-medium text-slate-600 hover:text-slate-900 py-1 cursor-pointer"
                >
                  Back to Sign In
                </button>
              )}
            </form>
          </div>
        </section>
      </main>
    </div>
  );
};
