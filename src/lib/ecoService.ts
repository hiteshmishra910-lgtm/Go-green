import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  type AccountStatus,
  type AiClassificationFailureDetails,
  type AiQuotaCategory,
  type AiWastePrediction,
  type AppSettings,
  BOOTSTRAPPED_ADMIN_EMAIL,
  type CollectionStatus,
  type CollectorApplication,
  DEFAULT_POINTS_BY_CATEGORY,
  DEFAULT_SERVICE_AREAS,
  FIELD_LIMITS,
  type ResidentCard,
  type UserProfile,
  type UserRole,
  type WasteCategory,
  type WasteCollectionRecord,
} from '../types/ecoverify';

function clampString(val: string | undefined, max: number): string {
  return (val ?? '').trim().slice(0, max);
}

export function generateUniqueResidentId(uid: string): string {
  const cleanUid = uid.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const prefix = cleanUid.slice(0, 4).padEnd(4, 'X');
  const suffix = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase().padEnd(4, '7');
  return `ECO-${prefix}${suffix}`;
}

export function generateDocumentId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now()}_${rand}`;
}

export function formatTimestamp(ts: unknown): string {
  if (!ts) return 'Just now';
  if (typeof ts === 'object' && ts !== null && 'toDate' in ts && typeof (ts as { toDate: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (typeof ts === 'string' || typeof ts === 'number') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
  return 'Just now';
}

export function toDate(ts: unknown): Date {
  if (typeof ts === 'object' && ts !== null && 'toDate' in ts && typeof (ts as { toDate: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate();
  }
  if (typeof ts === 'string' || typeof ts === 'number') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export async function ensureUserProfile(
  user: User,
  defaults?: {
    name?: string;
    phone?: string;
    address?: string;
    area?: string;
  }
): Promise<UserProfile> {
  const userRef = doc(db, 'users', user.uid);
  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
  }

  if (snap.exists()) {
    return snap.data() as UserProfile;
  }

  const isBootstrappedAdmin =
    user.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase() &&
    user.emailVerified;

  const role: UserRole = isBootstrappedAdmin ? 'admin' : 'resident';
  const residentId = generateUniqueResidentId(user.uid);
  const displayName = clampString(
    defaults?.name || user.displayName || user.email?.split('@')[0] || 'EcoVerify Member',
    FIELD_LIMITS.NAME_MAX
  );
  const area = clampString(defaults?.area || DEFAULT_SERVICE_AREAS[0], FIELD_LIMITS.AREA_MAX);
  const phone = clampString(defaults?.phone || '', FIELD_LIMITS.PHONE_MAX);
  const address = clampString(defaults?.address || '', FIELD_LIMITS.ADDRESS_MAX);
  const photoUrl = clampString(user.photoURL || '', 1000);
  const email = clampString(user.email || '', 254);

  const now = serverTimestamp();

  const userProfileData: Record<string, unknown> = {
    uid: user.uid,
    email,
    name: displayName,
    phone,
    address,
    area,
    photoUrl,
    role,
    accountStatus: 'active',
    residentId,
    assignedArea: role === 'admin' ? DEFAULT_SERVICE_AREAS[0] : '',
    rewardPoints: 0,
    createdAt: now,
    updatedAt: now,
  };

  const residentCardData: Record<string, unknown> = {
    uid: user.uid,
    residentId,
    name: displayName,
    area,
    pickupAddress: address,
    photoUrl,
    accountStatus: 'active',
    rewardPoints: 0,
    totalCollections: 0,
    createdAt: now,
    updatedAt: now,
  };

  const leaderboardData: Record<string, unknown> = {
    uid: user.uid,
    residentId,
    name: displayName,
    area,
    rewardPoints: 0,
    totalCollections: 0,
    totalWeightKg: 0,
    updatedAt: now,
  };

  const batch = writeBatch(db);
  batch.set(userRef, userProfileData);
  batch.set(doc(db, 'residentCards', residentId), residentCardData);
  batch.set(doc(db, 'leaderboard', user.uid), leaderboardData);

  if (isBootstrappedAdmin) {
    batch.set(doc(db, 'admins', user.uid), {
      uid: user.uid,
      email,
      grantedBy: 'system_bootstrap',
      createdAt: now,
    });
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
  }

  const created = await getDoc(userRef);
  return created.data() as UserProfile;
}

export async function updateResidentProfile(
  profile: UserProfile,
  updates: {
    name: string;
    phone: string;
    address: string;
    area: string;
    photoUrl: string;
  }
): Promise<void> {
  const name = clampString(updates.name, FIELD_LIMITS.NAME_MAX);
  if (!name) {
    throw new Error('Display name is required.');
  }
  const phone = clampString(updates.phone, FIELD_LIMITS.PHONE_MAX);
  const address = clampString(updates.address, FIELD_LIMITS.ADDRESS_MAX);
  const area = clampString(updates.area, FIELD_LIMITS.AREA_MAX);
  const photoUrl = clampString(updates.photoUrl, 1000);
  const now = serverTimestamp();

  const batch = writeBatch(db);
  batch.update(doc(db, 'users', profile.uid), {
    name,
    phone,
    address,
    area,
    photoUrl,
    updatedAt: now,
  });
  batch.update(doc(db, 'residentCards', profile.residentId), {
    name,
    area,
    pickupAddress: address,
    photoUrl,
    updatedAt: now,
  });
  batch.update(doc(db, 'leaderboard', profile.uid), {
    name,
    area,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${profile.uid}`);
  }
}

export async function submitCollectorApplication(
  profile: UserProfile,
  input: {
    phone: string;
    preferredArea: string;
    badgeNumber: string;
    notes: string;
  }
): Promise<void> {
  const phone = clampString(input.phone, FIELD_LIMITS.PHONE_MAX);
  const preferredArea = clampString(input.preferredArea, FIELD_LIMITS.AREA_MAX);
  const badgeNumber = clampString(input.badgeNumber, 40);
  const notes = clampString(input.notes, 400);

  if (phone.length < 5 || preferredArea.length < 2) {
    throw new Error('Please provide a valid phone number and preferred collection area.');
  }

  const now = serverTimestamp();
  const ref = doc(db, 'collectorApplications', profile.uid);
  const batch = writeBatch(db);
  batch.set(ref, {
    uid: profile.uid,
    name: clampString(profile.name, FIELD_LIMITS.NAME_MAX),
    email: clampString(profile.email, 254),
    phone,
    preferredArea,
    badgeNumber,
    notes,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `collectorApplications/${profile.uid}`);
  }
}

export function extractResidentIdFromQr(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // Support direct ECO-XXXX format
  const upper = trimmed.toUpperCase();
  if (/^ECO-[A-Z0-9]{4,24}$/.test(upper)) {
    return upper;
  }

  // Support ecoverify:resident:ECO-XXXX URI format
  const uriMatch = upper.match(/ECOVERIFY:RESIDENT:(ECO-[A-Z0-9]{4,24})/);
  if (uriMatch) {
    return uriMatch[1];
  }

  // Support JSON payload containing residentId
  try {
    const parsed = JSON.parse(trimmed) as { residentId?: unknown };
    if (typeof parsed.residentId === 'string') {
      const candidate = parsed.residentId.trim().toUpperCase();
      if (/^[A-Z0-9-]{4,32}$/.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Not JSON
  }

  // Support plain alphanumeric resident IDs
  if (/^[A-Z0-9-]{4,32}$/.test(upper)) {
    return upper;
  }

  return null;
}

export async function lookupResidentByQrOrId(rawInput: string): Promise<ResidentCard> {
  const residentId = extractResidentIdFromQr(rawInput);
  if (!residentId) {
    throw new Error('Invalid Resident ID or QR code format. Expected format like ECO-XXXX.');
  }

  const cardRef = doc(db, 'residentCards', residentId);
  let snap;
  try {
    snap = await getDoc(cardRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `residentCards/${residentId}`);
  }

  if (!snap.exists()) {
    throw new Error(`No registered resident found for ID "${residentId}".`);
  }

  return snap.data() as ResidentCard;
}

export async function createPickupRequest(
  profile: UserProfile,
  input: {
    category: WasteCategory;
    weightKg: number;
    notes: string;
    latitude?: number;
    longitude?: number;
  }
): Promise<string> {
  const collectionId = generateDocumentId('col');
  const now = serverTimestamp();
  const payload: Record<string, unknown> = {
    collectionId,
    residentUid: profile.uid,
    residentId: profile.residentId,
    residentName: clampString(profile.name, FIELD_LIMITS.NAME_MAX),
    collectorUid: '',
    collectorName: '',
    area: clampString(profile.area || DEFAULT_SERVICE_AREAS[0], FIELD_LIMITS.AREA_MAX),
    address: clampString(profile.address || '', FIELD_LIMITS.ADDRESS_MAX),
    category: input.category,
    weightKg: Math.max(0, Math.min(10000, Number(input.weightKg) || 0)),
    status: 'pending',
    collectorCorrected: false,
    pointsAwarded: 0,
    notes: clampString(input.notes, FIELD_LIMITS.NOTES_MAX),
    createdAt: now,
    updatedAt: now,
  };

  if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
    payload.latitude = input.latitude;
    payload.longitude = input.longitude;
  }

  const batch = writeBatch(db);
  batch.set(doc(db, 'collections', collectionId), payload);

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `collections/${collectionId}`);
  }

  return collectionId;
}

export async function submitVerifiedCollection(
  collector: UserProfile,
  params: {
    existingPendingCollection?: WasteCollectionRecord | null;
    residentCard: ResidentCard;
    category: WasteCategory;
    weightKg: number;
    status: 'collected' | 'rejected';
    aiPrediction: AiWastePrediction | null;
    collectorCorrected: boolean;
    pointsByCategory: Record<WasteCategory, number>;
    notes: string;
    latitude?: number;
    longitude?: number;
  }
): Promise<{ collectionId: string; pointsAwarded: number }> {
  const { residentCard, existingPendingCollection, status, category, aiPrediction } = params;
  if (residentCard.accountStatus !== 'active') {
    throw new Error(
      `Resident account (${residentCard.residentId}) is ${residentCard.accountStatus} and cannot receive collections.`
    );
  }

  if (status === 'collected' && category === 'Other / Unrecognized') {
    throw new Error(
      'Cannot award points for an unrecognized classification. Select a valid waste category or mark as Rejected.'
    );
  }

  const weightKg = Math.max(0, Math.min(10000, Number(params.weightKg) || 0));
  const rawPoints =
    status === 'collected' && category !== 'Other / Unrecognized'
      ? (params.pointsByCategory[category] ?? DEFAULT_POINTS_BY_CATEGORY[category] ?? 0)
      : 0;
  const pointsAwarded = Math.max(0, Math.min(100, Math.round(rawPoints)));

  const collectionId = existingPendingCollection?.collectionId || generateDocumentId('col');
  const txId = `tx_${collectionId}`;
  const notifId = generateDocumentId('notif');
  const now = serverTimestamp();

  // Fetch current resident leaderboard + user balance so batch increment is exact
  const [lbSnap, userSnap] = await Promise.all([
    getDoc(doc(db, 'leaderboard', residentCard.uid)).catch((err) =>
      handleFirestoreError(err, OperationType.GET, `leaderboard/${residentCard.uid}`)
    ),
    getDoc(doc(db, 'users', residentCard.uid)).catch(() => null),
  ]);

  const currentLbPoints = lbSnap.exists()
    ? Number((lbSnap.data() as { rewardPoints?: number }).rewardPoints ?? residentCard.rewardPoints)
    : residentCard.rewardPoints;
  const currentLbCollections = lbSnap.exists()
    ? Number((lbSnap.data() as { totalCollections?: number }).totalCollections ?? residentCard.totalCollections)
    : residentCard.totalCollections;
  const currentLbWeight = lbSnap.exists()
    ? Number((lbSnap.data() as { totalWeightKg?: number }).totalWeightKg ?? 0)
    : 0;

  const batch = writeBatch(db);
  const collectionRef = doc(db, 'collections', collectionId);

  const aiFields: Record<string, unknown> = aiPrediction
    ? {
        aiCategory: clampString(aiPrediction.category, 40),
        aiConfidence: Math.max(0, Math.min(100, Math.round(aiPrediction.confidence))),
        aiExplanation: clampString(aiPrediction.description || aiPrediction.explanation, 500),
        aiRecyclable: Boolean(aiPrediction.recyclable),
        aiDisposalSuggestion: clampString(aiPrediction.disposalSuggestion, 500),
      }
    : {};

  const geoFields: Record<string, unknown> =
    typeof params.latitude === 'number' && typeof params.longitude === 'number'
      ? { latitude: params.latitude, longitude: params.longitude }
      : {};

  if (existingPendingCollection) {
    batch.update(collectionRef, {
      collectorUid: collector.uid,
      collectorName: clampString(collector.name, FIELD_LIMITS.NAME_MAX),
      category,
      weightKg,
      status,
      ...aiFields,
      collectorCorrected: params.collectorCorrected,
      pointsAwarded,
      ...geoFields,
      notes: clampString(params.notes, FIELD_LIMITS.NOTES_MAX),
      updatedAt: now,
    });
  } else {
    batch.set(collectionRef, {
      collectionId,
      residentUid: residentCard.uid,
      residentId: residentCard.residentId,
      residentName: clampString(residentCard.name, FIELD_LIMITS.NAME_MAX),
      collectorUid: collector.uid,
      collectorName: clampString(collector.name, FIELD_LIMITS.NAME_MAX),
      area: clampString(residentCard.area || collector.assignedArea || DEFAULT_SERVICE_AREAS[0], FIELD_LIMITS.AREA_MAX),
      address: clampString(residentCard.pickupAddress || '', FIELD_LIMITS.ADDRESS_MAX),
      category,
      weightKg,
      status,
      ...aiFields,
      collectorCorrected: params.collectorCorrected,
      pointsAwarded,
      ...geoFields,
      notes: clampString(params.notes, FIELD_LIMITS.NOTES_MAX),
      createdAt: now,
      updatedAt: now,
    });
  }

  if (status === 'collected') {
    batch.set(doc(db, 'rewardTransactions', txId), {
      txId,
      residentUid: residentCard.uid,
      residentId: residentCard.residentId,
      collectionId,
      points: pointsAwarded,
      category,
      reason: `Verified ${category} collection (${weightKg.toFixed(1)} kg)`,
      awardedByUid: collector.uid,
      awardedByRole: 'collector',
      createdAt: now,
    });

    batch.update(doc(db, 'residentCards', residentCard.residentId), {
      rewardPoints: residentCard.rewardPoints + pointsAwarded,
      totalCollections: residentCard.totalCollections + 1,
      updatedAt: now,
    });

    if (lbSnap.exists()) {
      batch.update(doc(db, 'leaderboard', residentCard.uid), {
        rewardPoints: currentLbPoints + pointsAwarded,
        totalCollections: currentLbCollections + 1,
        totalWeightKg: Number((currentLbWeight + weightKg).toFixed(2)),
        updatedAt: now,
      });
    }

    if (userSnap && userSnap.exists()) {
      const userPts = Number((userSnap.data() as { rewardPoints?: number }).rewardPoints ?? 0);
      batch.update(doc(db, 'users', residentCard.uid), {
        rewardPoints: userPts + pointsAwarded,
        updatedAt: now,
      });
    }
  }

  batch.set(doc(db, 'notifications', notifId), {
    notificationId: notifId,
    recipientUid: residentCard.uid,
    senderUid: collector.uid,
    senderName: clampString(collector.name, FIELD_LIMITS.NAME_MAX),
    type: status === 'collected' ? 'reward' : 'collection_update',
    title:
      status === 'collected'
        ? `Collection Verified: +${pointsAwarded} Points`
        : 'Collection Pickup Rejected',
    message:
      status === 'collected'
        ? `Your ${category} drop-off (${weightKg.toFixed(1)} kg) was verified by ${collector.name}. ${pointsAwarded} reward points were credited.`
        : `Your ${category} collection could not be accepted. ${params.notes ? `Note: ${params.notes}` : 'Please check sorting guidelines.'}`,
    read: false,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `collections/${collectionId}`);
  }

  return { collectionId, pointsAwarded };
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'notifications', notificationId), {
    read: true,
    updatedAt: serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `notifications/${notificationId}`);
  }
}

export async function sendNotification(
  sender: UserProfile,
  recipientUid: string,
  payload: {
    type: 'collection_update' | 'reward' | 'system' | 'area_notice';
    title: string;
    message: string;
  }
): Promise<void> {
  const notificationId = generateDocumentId('notif');
  const now = serverTimestamp();
  const batch = writeBatch(db);
  batch.set(doc(db, 'notifications', notificationId), {
    notificationId,
    recipientUid,
    senderUid: sender.uid,
    senderName: clampString(sender.name, FIELD_LIMITS.NAME_MAX),
    type: payload.type,
    title: clampString(payload.title, FIELD_LIMITS.TITLE_MAX),
    message: clampString(payload.message, FIELD_LIMITS.MESSAGE_MAX),
    read: false,
    createdAt: now,
    updatedAt: now,
  });
  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `notifications/${notificationId}`);
  }
}

export async function adminUpdateUserAccount(
  admin: UserProfile,
  target: UserProfile,
  updates: {
    role?: UserRole;
    accountStatus?: AccountStatus;
    assignedArea?: string;
  }
): Promise<void> {
  const now = serverTimestamp();
  const nextRole = updates.role ?? target.role;
  const nextStatus = updates.accountStatus ?? target.accountStatus;
  const nextAssignedArea = clampString(
    updates.assignedArea ?? target.assignedArea ?? '',
    FIELD_LIMITS.AREA_MAX
  );

  const batch = writeBatch(db);
  batch.update(doc(db, 'users', target.uid), {
    role: nextRole,
    accountStatus: nextStatus,
    assignedArea: nextAssignedArea,
    updatedAt: now,
  });

  batch.update(doc(db, 'residentCards', target.residentId), {
    accountStatus: nextStatus,
    updatedAt: now,
  });

  if (nextRole === 'admin' && target.role !== 'admin') {
    batch.set(doc(db, 'admins', target.uid), {
      uid: target.uid,
      email: target.email,
      grantedBy: admin.uid,
      createdAt: now,
    });
  } else if (nextRole !== 'admin' && target.role === 'admin' && target.uid !== admin.uid) {
    batch.delete(doc(db, 'admins', target.uid));
  }

  const notifId = generateDocumentId('notif');
  batch.set(doc(db, 'notifications', notifId), {
    notificationId: notifId,
    recipientUid: target.uid,
    senderUid: admin.uid,
    senderName: clampString(admin.name, FIELD_LIMITS.NAME_MAX),
    type: 'system',
    title: 'Account Access Updated',
    message: `Your EcoVerify account role is now ${nextRole} (${nextStatus})${nextAssignedArea ? ` · Assigned area: ${nextAssignedArea}` : ''}.`,
    read: false,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${target.uid}`);
  }
}

export async function adminReviewCollectorApplication(
  admin: UserProfile,
  application: CollectorApplication,
  decision: 'approved' | 'rejected',
  assignedArea: string
): Promise<void> {
  const now = serverTimestamp();
  const area = clampString(assignedArea || application.preferredArea, FIELD_LIMITS.AREA_MAX);
  const batch = writeBatch(db);

  batch.update(doc(db, 'collectorApplications', application.uid), {
    status: decision,
    reviewedBy: admin.uid,
    updatedAt: now,
  });

  if (decision === 'approved') {
    batch.update(doc(db, 'users', application.uid), {
      role: 'collector',
      accountStatus: 'active',
      assignedArea: area,
      updatedAt: now,
    });
  }

  const notifId = generateDocumentId('notif');
  batch.set(doc(db, 'notifications', notifId), {
    notificationId: notifId,
    recipientUid: application.uid,
    senderUid: admin.uid,
    senderName: clampString(admin.name, FIELD_LIMITS.NAME_MAX),
    type: 'system',
    title:
      decision === 'approved'
        ? 'Collector Application Approved'
        : 'Collector Application Declined',
    message:
      decision === 'approved'
        ? `You have been approved as an EcoVerify Collector for ${area}. Sign in or refresh to access the Collector Dashboard.`
        : 'Your collector application was not approved at this time. Contact municipal support for details.',
    read: false,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `collectorApplications/${application.uid}`);
  }
}

export async function adminAdjustRewardPoints(
  admin: UserProfile,
  target: UserProfile,
  deltaPoints: number,
  reason: string
): Promise<void> {
  const cleanDelta = Math.round(deltaPoints);
  if (!Number.isFinite(cleanDelta) || cleanDelta === 0) {
    throw new Error('Point adjustment must be a non-zero integer.');
  }
  const cleanReason = clampString(reason, FIELD_LIMITS.REASON_MAX);
  if (!cleanReason) {
    throw new Error('An audit reason is required when adjusting reward points.');
  }

  const nextPoints = Math.max(0, target.rewardPoints + cleanDelta);
  const txId = generateDocumentId('adj');
  const notifId = generateDocumentId('notif');
  const now = serverTimestamp();

  const batch = writeBatch(db);
  batch.set(doc(db, 'rewardTransactions', txId), {
    txId,
    residentUid: target.uid,
    residentId: target.residentId,
    points: cleanDelta,
    category: 'Admin Adjustment',
    reason: cleanReason,
    awardedByUid: admin.uid,
    awardedByRole: 'admin',
    createdAt: now,
  });

  batch.update(doc(db, 'users', target.uid), {
    rewardPoints: nextPoints,
    updatedAt: now,
  });

  batch.update(doc(db, 'residentCards', target.residentId), {
    rewardPoints: nextPoints,
    updatedAt: now,
  });

  batch.update(doc(db, 'leaderboard', target.uid), {
    rewardPoints: nextPoints,
    updatedAt: now,
  });

  batch.set(doc(db, 'notifications', notifId), {
    notificationId: notifId,
    recipientUid: target.uid,
    senderUid: admin.uid,
    senderName: clampString(admin.name, FIELD_LIMITS.NAME_MAX),
    type: 'reward',
    title: `Reward Points Adjusted (${cleanDelta > 0 ? `+${cleanDelta}` : cleanDelta})`,
    message: `${cleanReason}. Updated balance: ${nextPoints} pts.`,
    read: false,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `rewardTransactions/${txId}`);
  }
}

export async function adminSaveAppSettings(
  admin: UserProfile,
  pointsByCategory: Record<WasteCategory, number>,
  serviceAreas: string[]
): Promise<void> {
  const cleanAreas = serviceAreas
    .map((a) => a.trim().slice(0, FIELD_LIMITS.AREA_MAX))
    .filter(Boolean)
    .slice(0, 50);

  const now = serverTimestamp();
  const batch = writeBatch(db);
  batch.set(doc(db, 'settings', 'app'), {
    settingId: 'app',
    pointsByCategory,
    serviceAreas: cleanAreas.length > 0 ? cleanAreas : DEFAULT_SERVICE_AREAS,
    updatedBy: admin.uid,
    updatedAt: now,
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'settings/app');
  }
}

export class AiClassificationError extends Error {
  details: AiClassificationFailureDetails;

  constructor(details: AiClassificationFailureDetails) {
    super(details.message);
    this.name = 'AiClassificationError';
    this.details = details;
  }
}

const VALID_QUOTA_CATEGORIES = new Set<AiQuotaCategory>([
  'rate_limit_rpm_tpm',
  'daily_quota',
  'billing_or_spend_cap',
  'model_overload',
  'auth_error',
  'timeout',
  'invalid_input',
  'unknown',
]);

export async function classifyWasteImage(
  imageBase64: string,
  mimeType: string
): Promise<AiWastePrediction> {
  const response = await fetch('/api/classify-waste', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ imageBase64, mimeType }),
  });

  const rawText = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const retryAfterHeader = response.headers.get('retry-after');
  const parsedRetryAfterHeader =
    retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())
      ? Number(retryAfterHeader.trim())
      : undefined;

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    const isHtml = contentType.includes('text/html') || rawText.trim().startsWith('<');
    throw new AiClassificationError({
      message: isHtml
        ? `AI API route (/api/classify-waste) returned an HTML page (HTTP ${response.status}) instead of JSON. Ensure the backend server is running.`
        : `AI service returned HTTP ${response.status} with non-JSON response.`,
      code: isHtml ? 'HTML_RESPONSE' : 'NON_JSON_RESPONSE',
      quotaCategory: 'unknown',
      httpStatus: response.status,
      retryAfterSeconds: parsedRetryAfterHeader,
      retryable: response.status >= 500,
    });
  }

  if (!response.ok) {
    const errMsg =
      typeof data.error === 'string' && data.error.trim().length > 0
        ? data.error.trim()
        : `AI classification failed (HTTP ${response.status}).`;

    const rawQuotaCategory =
      typeof data.quotaCategory === 'string' &&
      VALID_QUOTA_CATEGORIES.has(data.quotaCategory as AiQuotaCategory)
        ? (data.quotaCategory as AiQuotaCategory)
        : 'unknown';

    const retryAfterSeconds =
      typeof data.retryAfterSeconds === 'number' && Number.isFinite(data.retryAfterSeconds)
        ? Math.max(1, Math.ceil(data.retryAfterSeconds))
        : parsedRetryAfterHeader;

    throw new AiClassificationError({
      message: errMsg,
      code: typeof data.code === 'string' ? data.code : 'AI_UPSTREAM_ERROR',
      quotaCategory: rawQuotaCategory,
      httpStatus: response.status,
      upstreamStatus:
        typeof data.upstreamStatus === 'number' ? data.upstreamStatus : undefined,
      upstreamErrorStatus:
        typeof data.upstreamErrorStatus === 'string'
          ? data.upstreamErrorStatus
          : undefined,
      retryAfterSeconds,
      diagnosticDetail:
        typeof data.diagnosticDetail === 'string' ? data.diagnosticDetail : undefined,
      retryable: typeof data.retryable === 'boolean' ? data.retryable : response.status === 429 || response.status >= 500,
    });
  }

  const rawCategory = typeof data.category === 'string' ? data.category.trim() : '';
  const validCategory: WasteCategory =
    rawCategory === 'Plastic' ||
    rawCategory === 'Paper' ||
    rawCategory === 'Metal' ||
    rawCategory === 'Glass' ||
    rawCategory === 'Organic' ||
    rawCategory === 'E-waste' ||
    rawCategory === 'Other / Unrecognized'
      ? rawCategory
      : 'Other / Unrecognized';

  const humanDetected =
    Boolean(data.humanDetected) || data.subjectType === 'human';
  const subjectType = humanDetected
    ? 'human'
    : data.subjectType === 'waste' ||
        data.subjectType === 'non_waste' ||
        data.subjectType === 'unclear'
      ? data.subjectType
      : validCategory === 'Other / Unrecognized'
        ? 'unclear'
        : 'waste';

  const success =
    Boolean(data.success) &&
    !humanDetected &&
    validCategory !== 'Other / Unrecognized';

  const description =
    typeof data.description === 'string' && data.description.trim()
      ? data.description.trim()
      : typeof data.explanation === 'string' && data.explanation.trim()
        ? data.explanation.trim()
        : 'Visual inspection completed.';

  const points =
    success && typeof data.points === 'number' && Number.isFinite(data.points)
      ? Math.max(0, Math.round(data.points))
      : 0;

  return {
    success,
    category: validCategory,
    confidence:
      typeof data.confidence === 'number' && Number.isFinite(data.confidence)
        ? Math.min(95, Math.max(0, Math.round(data.confidence)))
        : 0,
    description,
    recyclable: success ? Boolean(data.recyclable) : false,
    points,
    ...(typeof data.error === 'string' && data.error.trim()
      ? { error: data.error.trim() }
      : {}),
    humanDetected,
    subjectType,
    detectedSubject:
      typeof data.detectedSubject === 'string' && data.detectedSubject.trim()
        ? data.detectedSubject.trim()
        : validCategory,
    explanation: description,
    disposalSuggestion:
      typeof data.disposalSuggestion === 'string' && data.disposalSuggestion.trim()
        ? data.disposalSuggestion.trim()
        : 'Confirm material separation according to municipal sorting guidelines.',
    disclaimer:
      typeof data.disclaimer === 'string' && data.disclaimer.trim()
        ? data.disclaimer.trim()
        : 'AI estimate only — not guaranteed 100% accurate. Collector confirmation applies.',
    cached: Boolean(data.cached),
  };
}

export function exportCollectionsToCsv(records: WasteCollectionRecord[]): void {
  const headers = [
    'Collection ID',
    'Date',
    'Resident ID',
    'Resident Name',
    'Collector Name',
    'Area',
    'Final Category',
    'AI Predicted Category',
    'AI Confidence (%)',
    'Collector Corrected',
    'Weight (kg)',
    'Status',
    'Points Awarded',
    'Notes',
  ];

  const escapeCsv = (val: unknown): string => {
    const str = String(val ?? '');
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = records.map((r) => [
    r.collectionId,
    toDate(r.createdAt).toISOString(),
    r.residentId,
    r.residentName,
    r.collectorName || 'Unassigned',
    r.area,
    r.category,
    r.aiCategory || 'N/A',
    r.aiConfidence ?? '',
    r.collectorCorrected ? 'Yes' : 'No',
    r.weightKg,
    r.status,
    r.pointsAwarded,
    r.notes || '',
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(','))
    .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ecoverify-collections-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function fetchDefaultSettings(): Promise<AppSettings | null> {
  try {
    const snap = await getDoc(doc(db, 'settings', 'app'));
    if (!snap.exists()) return null;
    return snap.data() as AppSettings;
  } catch {
    return null;
  }
}

export function getCollectionRef() {
  return collection(db, 'collections');
}
