# Security

Please report vulnerabilities through GitHub's private security-advisory form,
not a public issue. Include the affected route or component, impact, and a
minimal reproduction. Do not access data belonging to another installation or
tenant while testing.

Supported security fixes target the current `main` branch. Self-hosters should
keep Node.js and the locked dependencies current and run `npm audit` when
updating. Production installations must use HTTPS, a stable random
`APP_SECRET`, and a database backup that includes the same secret. Never commit
`.env`, SMTP credentials, Smoobu tokens, databases, uploads, or backup files.
