import { isIP } from 'node:net';
import { z } from 'zod';

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
  'IGNORED',
] as const;
export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentStateSchema>;


export const IpSchema = z.string().refine((v) => isIP(v) !== 0, { message: 'adresse IP invalide' });

export const IncidentReportSchema = z.object({
  dedup_key: z.string().min(1).max(200).optional(),
  type: IncidentTypeSchema,
  score: z.number().min(0).max(1),
  detected_at: z.iso.datetime(),
  target_service: z.string().min(1).max(100).optional(),
  source_ip: IpSchema.nullable().optional(),
  targets: z.array(z.string().min(1).max(254)).max(100).default([]),
  stats: z
    .object({
      attempts: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      window_seconds: z.number().nonnegative(),
    })
    .partial()
    .optional(),
  evidence: z
    .array(
      z.object({
        kind: z.enum(['promql', 'logql']),
        query: z.string().max(2000),
        value: z.number(),
      }),
    )
    .max(50)
    .default([]),
});
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

export const TransactionRequestSchema = z
  .object({
    from_account_id: z.uuid(),
    to_account_id: z.uuid().optional(),
    to_iban: z.string().min(14).max(34).optional(),
    amount_cents: z.number().int().min(1).max(1_000_000),
    label: z.string().max(140).optional(),
  })
  .refine((v) => Boolean(v.to_account_id) !== Boolean(v.to_iban), {
    message: 'fournir to_account_id ou to_iban, pas les deux',
    path: ['to_account_id'],
  });
export type TransactionRequest = z.infer<typeof TransactionRequestSchema>;
