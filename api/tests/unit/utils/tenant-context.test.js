jest.mock('mongoose', () => {
  return {
    connection: { db: null },
  };
});

const mongoose = require('mongoose');
const {
  attachTenantContext,
  idString,
  TenantContextError,
} = require('../../../src/utils/tenant-context');

const USER = '507f1f77bcf86cd799439011';
const BRANCH = '507f1f77bcf86cd799439012';
const OTHER_BRANCH = '507f1f77bcf86cd799439013';
const LICENSE = '507f1f77bcf86cd799439014';

const makeDb = ({ branch = true, user = true } = {}) => ({
  collection: jest.fn((name) => ({
    findOne: jest
      .fn()
      .mockResolvedValue(
        name === 'branches'
          ? branch
            ? { _id: BRANCH, branch_name: 'Main Branch' }
            : null
          : user
            ? { _id: USER }
            : null
      ),
  })),
});

describe('tenant context', () => {
  beforeEach(() => {
    mongoose.connection.db = makeDb();
  });

  test('converts a BSON ObjectId without recursing through its id accessor', () => {
    const objectId = { toHexString: () => BRANCH };
    Object.defineProperty(objectId, '_id', { get: () => objectId });
    expect(idString(objectId)).toBe(BRANCH);
  });

  test('uses an explicit query branch and the authenticated license', async () => {
    const req = {
      session: { selectedBranchId: BRANCH },
      body: { license_id: OTHER_BRANCH },
      query: { branch_id: OTHER_BRANCH, branch: BRANCH, license: OTHER_BRANCH },
      headers: {},
    };
    const user = { _id: USER, license: LICENSE, branch_id: OTHER_BRANCH };

    const context = await attachTenantContext(req, user);

    expect(context.branchId.toString()).toBe(OTHER_BRANCH);
    expect(context.branchName).toBe('Main Branch');
    expect(context.licenseId.toString()).toBe(LICENSE);
    expect(req.body.license_id).toBe(LICENSE);
    expect(req.query.branch_id).toBe(OTHER_BRANCH);
    expect(req.query.branch).toBe(OTHER_BRANCH);
    expect(req.query.license).toBe(LICENSE);
  });

  test('uses the selected session branch when the request has no branch override', async () => {
    const req = {
      session: { selectedBranchId: BRANCH },
      body: {},
      query: {},
      headers: {},
    };
    const user = { _id: USER, license: LICENSE, branch_id: OTHER_BRANCH };

    const context = await attachTenantContext(req, user);

    expect(context.branchId.toString()).toBe(BRANCH);
    expect(context.licenseId.toString()).toBe(LICENSE);
  });

  test('prefers the X-Branch-Id header over query and session branches', async () => {
    const req = {
      session: { selectedBranchId: OTHER_BRANCH },
      body: {},
      query: { branch_id: OTHER_BRANCH },
      headers: { 'x-branch-id': BRANCH },
    };
    const user = { _id: USER, license: LICENSE };

    const context = await attachTenantContext(req, user);

    expect(context.branchId.toString()).toBe(BRANCH);
  });

  test('rejects a branch outside the current user or license', async () => {
    mongoose.connection.db = makeDb({ branch: false });
    const req = { session: { selectedBranchId: BRANCH }, body: {}, query: {} };
    const user = { _id: USER, license: LICENSE };

    await expect(attachTenantContext(req, user)).rejects.toBeInstanceOf(TenantContextError);
  });

  test('rejects a branch not present in the user branch access', async () => {
    mongoose.connection.db = makeDb({ user: false });
    const req = { session: { selectedBranchId: BRANCH }, body: {}, query: {} };
    const user = { _id: USER, license: LICENSE };

    await expect(attachTenantContext(req, user)).rejects.toBeInstanceOf(TenantContextError);
  });

  /*
   * A scoped integration token is not a person (found by the end-to-end run).
   *
   * resolveScopedToken shapes its principal like a lean user document, but its
   * `_id` is the TOKEN row's id - and there is no such row in `users`. The
   * persisted-user check therefore refused every request made with one, so the
   * API's own documented authentication for /api/v1
   * ("Authenticate with a scoped API token via the Authorization: Bearer
   * header") answered "The selected branch is not available for the current
   * user and license" to every call. A website could not read a catalogue at
   * all.
   *
   * The check still has to mean something, so what replaces it is the branch
   * lookup: a token whose branch does not exist, or belongs to another licence,
   * is refused exactly as before.
   */
  test('accepts a scoped token, whose id belongs to no user row', async () => {
    const db = makeDb({ user: false });
    mongoose.connection.db = db;
    const req = { body: {}, query: {}, headers: {} };
    const principal = {
      _id: USER, // the token row's id, not a person's
      id: USER,
      usertype: 'api',
      api_token: true,
      license: LICENSE,
      branch_access: [{ branch_id: BRANCH }],
      access: { item: { read: true } },
    };

    const context = await attachTenantContext(req, principal);

    expect(context.branchId.toString()).toBe(BRANCH);
    expect(context.licenseId.toString()).toBe(LICENSE);
    expect(context.branchName).toBe('Main Branch');
    // The check is genuinely skipped, not merely tolerated: nothing looked for
    // a user at all.
    expect(db.collection.mock.calls.map(([name]) => name)).not.toContain('users');
  });

  test('a scoped token is still refused when its branch does not exist', async () => {
    mongoose.connection.db = makeDb({ branch: false });
    const req = { body: {}, query: {}, headers: {} };
    const principal = {
      _id: USER,
      api_token: true,
      license: LICENSE,
      branch_access: [{ branch_id: BRANCH }],
    };

    await expect(attachTenantContext(req, principal)).rejects.toBeInstanceOf(TenantContextError);
  });

  test('a token with no branch access gets no tenant at all', async () => {
    mongoose.connection.db = makeDb();
    const req = { body: {}, query: {}, headers: {} };
    const principal = { _id: USER, api_token: true, license: LICENSE, branch_access: [] };

    /* No branch to validate means no tenant context - and a request with no
       tenant has no database attached, so /api/v1 answers `503 no_tenant`.
       Refused, by a different door: this is not the token path being waved
       through, and asserting the null is what keeps that distinction visible. */
    await expect(attachTenantContext(req, principal)).resolves.toBe(null);
    expect(req.tenantContext).toBe(null);
  });
});
