try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health/ready`, {
    signal: AbortSignal.timeout(4500),
  });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
