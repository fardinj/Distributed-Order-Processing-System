import { cp, copyFile, mkdir } from 'node:fs/promises';
const target = 'dist/apps/gateway/web';
await mkdir(`${target}/vendor`, { recursive: true });
await cp('apps/gateway/web', target, { recursive: true });
await cp('node_modules/keycloak-js/lib', `${target}/vendor`, { recursive: true });
await copyFile('node_modules/keycloak-js/LICENSE.txt', `${target}/vendor/keycloak-LICENSE.txt`);
for (const subset of ['arabic', 'latin'])
  await copyFile(
    `node_modules/@fontsource-variable/vazirmatn/files/vazirmatn-${subset}-wght-normal.woff2`,
    `${target}/vendor/vazirmatn-${subset}.woff2`,
  );
await copyFile(
  'node_modules/@fontsource-variable/vazirmatn/LICENSE',
  `${target}/vendor/font-LICENSE.txt`,
);
console.log('Static Persian client built with pinned local adapter and font.');
