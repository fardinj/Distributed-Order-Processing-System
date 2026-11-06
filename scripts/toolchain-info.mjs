// Maintainer helper; never called by application startup.
const packages = [
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/platform-express',
  '@prisma/client',
  'prisma',
  'typescript',
  'pg',
  'amqplib',
  'redis',
  'http-proxy-middleware',
  '@types/node',
  '@types/express',
  '@types/pg',
  '@types/amqplib',
];
for (const name of packages) {
  const response = await fetch(`https://registry.npmjs.org/${name}`);
  if (!response.ok) throw new Error(`Registry lookup failed: ${name}`);
  const metadata = await response.json();
  const version = metadata['dist-tags'].latest;
  console.log(JSON.stringify({ name, version, engines: metadata.versions[version].engines }));
}
for (const [repository, pattern] of [
  ['library/postgres', /^17\.\d+-bookworm$/],
  ['library/rabbitmq', /^4\.\d+\.\d+-management-alpine$/],
  ['library/redis', /^8\.\d+\.\d+-alpine$/],
]) {
  const response = await fetch(
    `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100&ordering=last_updated`,
  );
  const result = await response.json();
  console.log(
    JSON.stringify({
      repository,
      tags: result.results
        ?.filter((tag) => pattern.test(tag.name))
        .map((tag) => tag.name)
        .slice(0, 5),
    }),
  );
}
const release = await fetch('https://api.github.com/repos/keycloak/keycloak/releases/latest').then(
  (r) => r.json(),
);
console.log(JSON.stringify({ keycloak: release.tag_name }));
