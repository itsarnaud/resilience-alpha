-- Le service de reconnaissance faciale renvoie une distance (plus elle est petite, plus les visages se
-- ressemblent), pas un score : la colonne est renommée, sans perte de données.
ALTER TABLE "backoffice_logins" RENAME COLUMN "face_score" TO "face_distance";
