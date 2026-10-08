# Security Policy

## Reporting a vulnerability

Email security@dapperlabs.com with details. Do not open a public issue.

## Data

This project uses only public Flow Network data (on-chain ownership records) and public NBA Top Shot collector profile data (usernames, avatars). No private credentials, no user PII, no authentication.

## Analytics

The live deploy uses Plausible Analytics with `data-exclude-search` — query strings (including `?spotlight=<address>`) are never transmitted. Custom events send only numeric player IDs and a boolean spotlight flag.
