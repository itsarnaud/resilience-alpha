import { IncidentStateSchema } from '@resilience/shared';
import { z } from 'zod';

export const ListIncidentsQuerySchema = z.object({
  state: IncidentStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const IncidentIdParamSchema = z.object({ id: z.uuid() });
