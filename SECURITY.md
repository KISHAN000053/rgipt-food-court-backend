# Security Policy

## Supported versions

Security fixes are applied to the current default branch. Forks and deployments are maintained by their operators.

## Reporting a vulnerability

Please do not publish credentials, personal data, payment information, or a working exploit in a public issue. Contact the repository maintainer privately through GitHub's private vulnerability reporting feature when available, or use a private channel agreed with the maintainer. Include affected version/commit, impact, and minimal reproduction steps.

## If a secret is exposed

1. Revoke or rotate it at the provider immediately.
2. Update the hosting environment and redeploy.
3. Check provider logs for suspicious use.
4. Remove the value from the current source and investigate Git history; a new commit alone does not erase old commits.
5. Do not paste the secret into issues, chat, logs, or a replacement README.

## Deployment baseline

- Use HTTPS and a unique production `JWT_SECRET`.
- Restrict MongoDB network access and database-user permissions.
- Configure exact trusted frontend origins.
- Verify Razorpay webhook signatures and test payment/refund flows in test mode.
- Keep provider secrets in the host's environment/secret manager, never in frontend `VITE_*` values.
- Review access-control changes and CI results before deploying.
