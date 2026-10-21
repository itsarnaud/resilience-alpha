import { z } from 'zod';

export const BlockIdParamSchema = z.object({ id: z.uuid() });
