import { expect, it } from 'vitest';
import { developmentDefaults } from '../src/dev-defaults.js';

it("keeps a development daemon's data, credentials and port apart from the live one's (R-G9)", () => {
  expect(developmentDefaults({ XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/config' })).toEqual({
    CRAFTINGTABLE_DATA_DIR: '/x/data/craftingtable-dev',
    CRAFTINGTABLE_CONFIG_DIR: '/x/config/craftingtable-dev',
    CRAFTINGTABLE_PORT: '4601',
  });
  expect(
    developmentDefaults({
      CRAFTINGTABLE_DATA_DIR: '/d',
      CRAFTINGTABLE_CONFIG_DIR: '/c',
      CRAFTINGTABLE_PORT: '4700',
    }),
  ).toEqual({
    CRAFTINGTABLE_DATA_DIR: '/d',
    CRAFTINGTABLE_CONFIG_DIR: '/c',
    CRAFTINGTABLE_PORT: '4700',
  });
});
