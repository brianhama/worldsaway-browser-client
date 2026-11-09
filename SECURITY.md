# Security

Report a suspected vulnerability privately to the repository maintainer using
the hosting platform's private vulnerability reporting feature when enabled.
If that feature is unavailable, ask the maintainer for a private reporting
channel without publishing exploit details, account data, or tickets.

Include the affected version, expected and observed behavior, and a minimal
reproduction using a local fixture. Do not test against a public world without
the operator's authorization.

The local bridge binds to loopback and enforces same-origin access. Public
hosting requires an exact HTTPS `ALTAWAY_PUBLIC_ORIGIN` and pins login, registration and world discovery to the operator-configured
backend. World scripts run in a separate Tcl process with a safe
child interpreter and explicit host bindings. The native backend determines
permissions and transactions; a browser form is not an authorization boundary.

Native TCP connections use the backend protocol's transport properties. HTTPS
protects the browser-to-bridge hop and does not add TLS to a direct native TCP
connection. Treat bridge memory as sensitive while users are connected.
