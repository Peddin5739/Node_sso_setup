const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const dotenv = require('dotenv');
const { createDb } = require('./db');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
const tenantId = process.env.AZURE_TENANT_ID || 'common';
const issuer = process.env.AZURE_ISSUER || `https://login.microsoftonline.com/${tenantId}/v2.0`;
const audienceValues = [process.env.AZURE_AUDIENCE, process.env.AZURE_CLIENT_ID].filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map((origin) => origin.trim());
const dbFilePath = process.env.AUTHZ_DB_FILE || './data/authz.sqlite';
const bootstrapAdminGroups = (process.env.BOOTSTRAP_ADMIN_GROUP_IDS || '')
  .split(',')
  .map((groupId) => groupId.trim())
  .filter(Boolean);

let authzDb;

const jwks = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
});

function getSigningKey(header, callback) {
  jwks.getSigningKey(header.kid, (error, key) => {
    if (error) {
      callback(error);
      return;
    }

    const signingKey = key.getPublicKey ? key.getPublicKey() : key.publicKey;
    callback(null, signingKey);
  });
}

function verifyAccessToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getSigningKey,
      {
        algorithms: ['RS256'],
        audience: audienceValues.length ? audienceValues : undefined,
        issuer,
      },
      (error, decoded) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(decoded);
      },
    );
  });
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
}

function parseGroups(payload) {
  if (Array.isArray(payload.groups)) {
    return payload.groups;
  }

  return [];
}

function includeBootstrapAdminRole(groupIds, roleNames) {
  const isBootstrapAdmin = groupIds.some((groupId) => bootstrapAdminGroups.includes(groupId));
  if (isBootstrapAdmin && !roleNames.includes('admin')) {
    roleNames.push('admin');
  }

  return roleNames;
}

async function authenticateRequest(req, res, next) {
  const bearerToken = getBearerToken(req);

  if (!bearerToken) {
    return res.status(401).json({ message: 'Missing bearer token.' });
  }

  try {
    const payload = await verifyAccessToken(bearerToken);
    const groupIds = parseGroups(payload);

    const dbUser = await authzDb.upsertUser({
      azureOid: payload.oid,
      tenantId: payload.tid,
      displayName: payload.name || payload.preferred_username || payload.upn,
      email: payload.preferred_username || payload.upn || payload.email,
    });

    let resolvedRoles = await authzDb.resolveRolesByGroups(groupIds);
    resolvedRoles = includeBootstrapAdminRole(groupIds, resolvedRoles);

    req.auth = {
      claims: payload,
      groups: groupIds,
      roles: resolvedRoles,
      dbUser,
    };

    return next();
  } catch (error) {
    console.error('Token validation failed:', error.message);
    return res.status(401).json({ message: 'Invalid or expired Azure token.' });
  }
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    const currentRoles = req.auth?.roles || [];
    const hasAccess = currentRoles.some((roleName) => roles.includes(roleName));

    if (!hasAccess) {
      return res.status(403).json({
        message: 'Access denied for this API.',
        requiredRoles: roles,
        currentRoles,
      });
    }

    return next();
  };
}

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'node-sso-setup' });
});

app.get('/api/profile', authenticateRequest, (req, res) => {
  return res.json({
    message: 'Protected node API reached successfully.',
    user: {
      name: req.auth.claims.name || req.auth.claims.preferred_username || req.auth.claims.upn,
      email: req.auth.claims.preferred_username || req.auth.claims.upn || req.auth.claims.email,
      tenantId: req.auth.claims.tid,
      objectId: req.auth.claims.oid,
    },
    groups: req.auth.groups,
    roles: req.auth.roles,
    claims: req.auth.claims,
  });
});

app.get('/api/user/data', authenticateRequest, requireAnyRole(['user', 'admin']), (req, res) => {
  return res.json({
    message: 'User API data returned successfully.',
    roles: req.auth.roles,
    user: req.auth.dbUser,
  });
});

app.get('/api/admin/data', authenticateRequest, requireAnyRole(['admin']), (req, res) => {
  return res.json({
    message: 'Admin API data returned successfully.',
    roles: req.auth.roles,
    user: req.auth.dbUser,
  });
});

app.get('/api/admin/roles', authenticateRequest, requireAnyRole(['admin']), async (req, res) => {
  const roles = await authzDb.listRoles();
  return res.json({ roles });
});

app.get('/api/admin/group-role-mappings', authenticateRequest, requireAnyRole(['admin']), async (req, res) => {
  const mappings = await authzDb.listGroupRoleMappings();
  return res.json({ mappings });
});

app.post('/api/admin/group-role-mappings', authenticateRequest, requireAnyRole(['admin']), async (req, res) => {
  const groupObjectId = `${req.body.groupObjectId || ''}`.trim();
  const roleName = `${req.body.roleName || ''}`.trim().toLowerCase();
  const groupName = `${req.body.groupName || ''}`.trim();

  if (!groupObjectId || !roleName) {
    return res.status(400).json({ message: 'groupObjectId and roleName are required.' });
  }

  const availableRoles = await authzDb.listRoles();
  const roleExists = availableRoles.some((role) => role.roleName === roleName);
  if (!roleExists) {
    return res.status(400).json({ message: 'Unknown role name.', availableRoles });
  }

  const mapping = await authzDb.createGroupRoleMapping(groupObjectId, roleName, groupName || null);
  return res.status(201).json({ message: 'Group to role mapping saved.', mapping });
});

app.delete('/api/admin/group-role-mappings/:groupObjectId/:roleName', authenticateRequest, requireAnyRole(['admin']), async (req, res) => {
  const groupObjectId = `${req.params.groupObjectId || ''}`.trim();
  const roleName = `${req.params.roleName || ''}`.trim().toLowerCase();

  const deletedRows = await authzDb.deleteGroupRoleMapping(groupObjectId, roleName);
  if (deletedRows === 0) {
    return res.status(404).json({ message: 'Mapping not found.' });
  }

  return res.json({ message: 'Mapping deleted.' });
});

async function start() {
  authzDb = await createDb(dbFilePath);
  app.listen(port, () => {
    console.log(`Node SSO API listening on http://localhost:${port}`);
    console.log(`Authorization DB: ${dbFilePath}`);
    if (bootstrapAdminGroups.length) {
      console.log(`Bootstrap admin groups loaded: ${bootstrapAdminGroups.length}`);
    }
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
