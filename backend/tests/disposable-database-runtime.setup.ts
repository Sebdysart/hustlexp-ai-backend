if (process.env.DATABASE_URL?.trim()) {
  const { installDisposableVitestDatabaseRuntime } = await import(
    '../src/test/disposable-database-runtime.js'
  );
  installDisposableVitestDatabaseRuntime();
}
