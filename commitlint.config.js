// Vérifie uniquement la forme du message de commit (voir "Règles de commit" dans le README).
// Pas de vérification du code ici (lint-staged, tests) : volontairement laissée hors de Husky.
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
