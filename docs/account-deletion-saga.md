# Account deletion consumer

`POST /internal/v1/account-deletions` accepts only a short-lived Schlussel
RS256 token with exact `hof-deletion:glocke` audience, deletion token use and
scope, and subject/job claims matching the strict request body.

One transaction records the job and permanent tombstone and purges all inbox
events, notifications, browser subscriptions, push deliveries, and the local
recipient mirror. Exact replay succeeds and mismatched identities conflict.
Access-token materialization and later producer events suppress tombstoned
recipients, preventing delayed valid input from restoring their data.
