ALTER TABLE `push_deliveries` ADD `settled_at` integer;--> statement-breakpoint
UPDATE `push_deliveries` SET `settled_at` = coalesce(`delivered_at`, unixepoch() * 1000)
WHERE `state` in ('delivered', 'suppressed', 'permanent');--> statement-breakpoint
CREATE INDEX `push_deliveries_retention_idx` ON `push_deliveries` (`state`,`settled_at`);--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `session_id` text;
