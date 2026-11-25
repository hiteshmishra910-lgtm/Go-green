export const WASTE_CATEGORIES = [
  'Plastic',
  'Paper',
  'Metal',
  'Glass',
  'Organic',
  'E-waste',
  'Other / Unrecognized',
] as const;

export type WasteCategory = (typeof WASTE_CATEGORIES)[number];

export type UserRole = 'resident' | 'collector' | 'admin';
export type AccountStatus = 'active' | 'pending' | 'suspended' | 'deactivated';
export type CollectionStatus = 'pending' | 'collected' | 'rejected';

export const DEFAULT_POINTS_BY_CATEGORY: Record<WasteCategory, number> = {
  Plastic: 15,
  Paper: 10,
  Metal: 15,
  Glass: 15,
  Organic: 10,
  'E-waste': 20,
  'Other / Unrecognized': 0,
};

export const DEFAULT_SERVICE_AREAS = [
  'North District - Zone A',
  'South District - Zone B',
  'East Garden Ward',
  'West Riverside Ward',
  'Central Civic Hub',
];

// Blueprint validation constants (synchronized with firebase-blueprint.json)
export const FIELD_LIMITS = {
  NAME_MAX: 120,
  PHONE_MAX: 32,
  ADDRESS_MAX: 300,
  AREA_MAX: 100,
  NOTES_MAX: 500,
  REASON_MAX: 300,
  TITLE_MAX: 140,
  MESSAGE_MAX: 600,
} as const;

export const BOOTSTRAPPED_ADMIN_EMAIL = 'hiteshmishra910@gmail.com';

export interface UserProfile {
  uid: string;
  email: string;
  name: string;
  phone?: string;
  address?: string;
  area?: string;
  photoUrl?: string;
  role: UserRole;
  accountStatus: AccountStatus;
  residentId: string;
  assignedArea?: string;
  rewardPoints: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface ResidentCard {
  uid: string;
  residentId: string;
  name: string;
  area: string;
  pickupAddress?: string;
  photoUrl?: string;
  accountStatus: AccountStatus;
  rewardPoints: number;
  totalCollections: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface LeaderboardEntry {
  uid: string;
  residentId: string;
  name: string;
  area: string;
  rewardPoints: number;
  totalCollections: number;
  totalWeightKg: number;
  updatedAt: unknown;
}

export interface CollectorApplication {
  uid: string;
  name: string;
  email: string;
  phone: string;
  preferredArea: string;
  badgeNumber?: string;
  notes?: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface WasteCollectionRecord {
  collectionId: string;
  residentUid: string;
  residentId: string;
  residentName: string;
  collectorUid: string;
  collectorName: string;
  area: string;
  address?: string;
  category: WasteCategory;
  weightKg: number;
  status: CollectionStatus;
  aiCategory?: string;
  aiConfidence?: number;
  aiExplanation?: string;
  aiRecyclable?: boolean;
  aiDisposalSuggestion?: string;
  collectorCorrected: boolean;
  pointsAwarded: number;
  latitude?: number;
  longitude?: number;
  notes?: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface RewardTransaction {
  txId: string;
  residentUid: string;
  residentId: string;
  collectionId?: string;
  points: number;
  category?: string;
  reason: string;
  awardedByUid: string;
  awardedByRole: 'collector' | 'admin';
  createdAt: unknown;
}

export interface NotificationRecord {
  notificationId: string;
  recipientUid: string;
  senderUid: string;
  senderName?: string;
  type: 'collection_update' | 'reward' | 'system' | 'area_notice';
  title: string;
  message: string;
  read: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface AppSettings {
  settingId: string;
  pointsByCategory: Record<WasteCategory, number>;
  serviceAreas: string[];
  updatedBy: string;
  updatedAt: unknown;
}

export type AiQuotaCategory =
  | 'rate_limit_rpm_tpm'
  | 'daily_quota'
  | 'billing_or_spend_cap'
  | 'model_overload'
  | 'auth_error'
  | 'timeout'
  | 'invalid_input'
  | 'unknown';

export interface AiClassificationFailureDetails {
  message: string;
  code: string;
  quotaCategory: AiQuotaCategory;
  httpStatus: number;
  upstreamStatus?: number;
  upstreamErrorStatus?: string;
  retryAfterSeconds?: number;
  diagnosticDetail?: string;
  retryable: boolean;
}

export interface AiWastePrediction {
  success: boolean;
  category: WasteCategory;
  confidence: number;
  description: string;
  recyclable: boolean;
  points: number;
  error?: string;
  subjectType: 'waste' | 'human' | 'non_waste' | 'unclear';
  humanDetected: boolean;
  detectedSubject: string;
  explanation: string;
  disposalSuggestion: string;
  disclaimer: string;
  cached?: boolean;
}
