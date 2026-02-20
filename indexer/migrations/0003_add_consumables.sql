CREATE TABLE IF NOT EXISTS "consumables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner" text NOT NULL UNIQUE,
  "xlife_count" integer NOT NULL DEFAULT 0,
  "attack_count" integer NOT NULL DEFAULT 0,
  "revive_count" integer NOT NULL DEFAULT 0,
  "poison_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp DEFAULT now()
);
