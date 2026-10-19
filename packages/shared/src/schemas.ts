import { z } from 'zod';

/** Rôles portés par les jetons (utilisateurs et services). */
export const ROLES = [
  'customer',
  'operator',
  'svc:detector',
  'svc:dashboard',
  'svc:remediation-canary',
] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const INCIDENT_TYPES = [
  'HTTP_FLOOD',
  'BRUTE_FORCE',
  'SERVICE_DOWN',
  'DATA_INCONSISTENCY',
  'INJECTION_ATTEMPT',
  'UNKNOWN_ANOMALY',
] as const;
export const IncidentTypeSchema = z.enum(INCIDENT_TYPES);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const INCIDENT_STATES = [
  'DETECTED',
  'REMEDIATING',
  'VERIFYING',
  'RESOLVED',
  'FAILED',
] as const;
export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

/** Corps de `POST /v1/incidents` (envoyé par le détecteur). */
export const IncidentReportSchema = z.object({
  dedup_key: z.string().min(1).max(200),
  type: IncidentTypeSchema,
  score: z.number().min(0).max(1),
  detected_at: z.string().datetime(),
  target_service: z.string().min(1).optional(),
  source_ip: z.string().min(3).max(45).nullable().optional(),
  evidence: z
    .array(
      z.object({
        kind: z.enum(['promql', 'logql']),
        query: z.string(),
        value: z.number(),
      }),
    )
    .default([]),
});
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

/** Corps de `POST /api/v1/transactions` : un compte interne OU un IBAN externe. */
export const TransactionRequestSchema = z
  .object({
    from_account_id: z.string().uuid(),
    to_account_id: z.string().uuid().optional(),
    to_iban: z.string().min(14).max(34).optional(),
    amount_cents: z.number().int().min(1).max(1_000_000),
    label: z.string().max(140).optional(),
  })
  .refine((v) => Boolean(v.to_account_id) !== Boolean(v.to_iban), {
    message: 'fournir to_account_id ou to_iban, pas les deux',
    path: ['to_account_id'],
  });
export type TransactionRequest = z.infer<typeof TransactionRequestSchema>;
