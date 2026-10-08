-- Difference between a reported holder count and observed serials.
-- This is NOT a bug count: serial coverage can be sampled or filtered.
WITH counts AS (
  SELECT address, COUNT(*) AS observed_count FROM observed GROUP BY address
)
SELECT COUNT(*) AS reported_vs_observed_differences
FROM holders h LEFT JOIN counts c ON h.address = c.address
WHERE h.reported != COALESCE(c.observed_count, 0);
