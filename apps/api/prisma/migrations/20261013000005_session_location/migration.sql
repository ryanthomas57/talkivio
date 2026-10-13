-- Approximate sign-in location for the account sessions list (ch. 07). City/country only,
-- derived at sign-in from proxy geo headers or the optional GeoLite database; never an IP.
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "location_label" TEXT;
