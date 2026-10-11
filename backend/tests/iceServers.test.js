/**
 * TURN relay credentials for voice calls (Cloudflare / coturn / static) and
 * graceful fallback to STUN-only.
 */
const crypto = require('crypto');
const env = require('../src/config/env');
const ice = require('../src/services/iceServers.service');

describe('ICE servers for voice calls', () => {
  const saved = {};
  const keys = ['TURN_URLS', 'TURN_SECRET', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN'];

  beforeEach(() => {
    keys.forEach((k) => {
      saved[k] = env[k];
      env[k] = '';
    });
    ice._resetCacheForTests();
  });

  afterEach(() => {
    keys.forEach((k) => {
      env[k] = saved[k];
    });
    jest.restoreAllMocks();
  });

  test('STUN only when no relay is configured', async () => {
    const servers = await ice.getIceServers('u1');
    expect(ice.turnMode()).toBe('NONE');
    expect(servers).toHaveLength(1);
    expect(servers[0].urls.every((u) => u.startsWith('stun:'))).toBe(true);
  });

  test('coturn shared secret produces valid time-limited credentials', async () => {
    env.TURN_URLS = 'turn:turn.example.ug:3478,turns:turn.example.ug:443?transport=tcp';
    env.TURN_SECRET = 'super-secret';
    const servers = await ice.getIceServers('u-abc');
    const turn = servers.find((s) => s.username);
    const [expiry, who] = turn.username.split(':');
    expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000);
    expect(who).toBe('u-abc');
    expect(turn.credential).toBe(crypto.createHmac('sha1', 'super-secret').update(turn.username).digest('base64'));
    expect(turn.urls).toContain('turns:turn.example.ug:443?transport=tcp');
  });

  test('Cloudflare credentials are minted through the API and cached', async () => {
    env.CLOUDFLARE_TURN_KEY_ID = 'key123';
    env.CLOUDFLARE_TURN_API_TOKEN = 'token456';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'cf-user', credential: 'cf-pass' },
        ],
      }),
    });
    const first = await ice.getIceServers('u1');
    await ice.getIceServers('u2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/turn/keys/key123/credentials/generate-ice-servers');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token456');
    expect(first.some((s) => s.username === 'cf-user')).toBe(true);
  });

  test('a relay outage never breaks calling: falls back to STUN', async () => {
    env.CLOUDFLARE_TURN_KEY_ID = 'key123';
    env.CLOUDFLARE_TURN_API_TOKEN = 'token456';
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    const servers = await ice.getIceServers('u1');
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.some((s) => s.username)).toBe(false);
  });
});
