import type { z } from 'zod';

/**
 * Valide les variables d'environnement avec un schéma zod.
 * Échoue au démarrage avec un message lisible plutôt qu'au premier appel.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join('\n');
    throw new Error(`Configuration invalide :\n${problems}`);
  }
  return result.data;
}
