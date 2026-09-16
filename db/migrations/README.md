# Database migrations

Versioned PostgreSQL migrations live in this directory. During the Step 2 bootstrap, PostgreSQL executes these files only when it initializes a new empty data volume.

Starting with Step 3, application-controlled migration execution must replace reliance on the Docker initialization hook for upgrades to an existing database.
