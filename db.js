const { Pool } = require('pg');

const DEFAULT_ROLES = [
  { roleKey: 'admin', displayName: 'Administrator', description: 'Access to admin and user APIs' },
  { roleKey: 'user', displayName: 'User', description: 'Access to user APIs only' },
];

async function createDb() {
  const pool = process.env.AUTHZ_DB_URL
    ? new Pool({ connectionString: process.env.AUTHZ_DB_URL })
    : new Pool({
        host: process.env.AUTHZ_DB_HOST || 'localhost',
        port: Number(process.env.AUTHZ_DB_PORT || 5432),
        database: process.env.AUTHZ_DB_NAME || 'sso_authz',
        user: process.env.AUTHZ_DB_USER || 'postgres',
        password: process.env.AUTHZ_DB_PASSWORD || undefined,
      });

  await pool.query('SELECT 1');

  for (const role of DEFAULT_ROLES) {
    await pool.query(
      `INSERT INTO authz.roles (role_key, display_name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (role_key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           updated_at = NOW();`,
      [role.roleKey, role.displayName, role.description],
    );
  }

  return {
    async listRoles() {
      const { rows } = await pool.query(
        `SELECT role_key AS "roleName", display_name AS "displayName",
                description, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM authz.roles
         WHERE is_active = TRUE
         ORDER BY role_key ASC;`,
      );

      return rows;
    },

    async upsertUser(user) {
      const { rows } = await pool.query(
        `INSERT INTO authz.users (azure_oid, tenant_id, display_name, email)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         ON CONFLICT (azure_oid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             display_name = EXCLUDED.display_name,
             email = EXCLUDED.email,
             updated_at = NOW()
         RETURNING id, azure_oid AS "azureOid", tenant_id AS "tenantId", display_name AS "displayName", email;`,
        [user.azureOid, user.tenantId, user.displayName, user.email],
      );

      return rows[0];
    },

    async listGroupRoleMappings() {
      const { rows } = await pool.query(
        `SELECT m.id,
                g.group_object_id::text AS "groupObjectId",
                g.group_name AS "groupName",
                r.role_key AS "roleName",
                m.created_at AS "createdAt",
                m.updated_at AS "updatedAt"
         FROM authz.group_role_mappings m
         JOIN authz.ad_groups g ON g.id = m.ad_group_id
         JOIN authz.roles r ON r.id = m.role_id
         ORDER BY g.group_object_id ASC, r.role_key ASC;`,
      );

      return rows;
    },

    async createGroupRoleMapping(groupObjectId, roleName, groupName) {
      const roleResult = await pool.query(
        `SELECT id FROM authz.roles WHERE role_key = $1 AND is_active = TRUE;`,
        [roleName],
      );

      if (roleResult.rows.length === 0) {
        return null;
      }

      const roleId = roleResult.rows[0].id;
      const groupResult = await pool.query(
        `INSERT INTO authz.ad_groups (group_object_id, group_name)
         VALUES ($1::uuid, $2)
         ON CONFLICT (group_object_id) DO UPDATE
         SET group_name = COALESCE(EXCLUDED.group_name, authz.ad_groups.group_name),
             updated_at = NOW()
         RETURNING id, group_name AS "groupName";`,
        [groupObjectId, groupName || null],
      );
      const groupId = groupResult.rows[0].id;

      const { rows } = await pool.query(
        `INSERT INTO authz.group_role_mappings (ad_group_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT (ad_group_id, role_id) DO UPDATE
         SET updated_at = NOW()
         RETURNING id, created_at AS "createdAt", updated_at AS "updatedAt";`,
        [groupId, roleId],
      );

      return {
        id: rows[0].id,
        groupObjectId,
        groupName: groupResult.rows[0].groupName,
        roleName,
        createdAt: rows[0].createdAt,
        updatedAt: rows[0].updatedAt,
      };
    },

    async deleteGroupRoleMapping(groupObjectId, roleName) {
      const { rowCount } = await pool.query(
        `DELETE FROM authz.group_role_mappings m
         USING authz.ad_groups g, authz.roles r
         WHERE m.ad_group_id = g.id
           AND m.role_id = r.id
           AND g.group_object_id = $1::uuid
           AND r.role_key = $2;`,
        [groupObjectId, roleName],
      );

      return rowCount;
    },

    async resolveRolesByGroups(groupObjectIds) {
      if (!Array.isArray(groupObjectIds) || groupObjectIds.length === 0) {
        return [];
      }

      const { rows } = await pool.query(
        `SELECT DISTINCT r.role_key AS "roleName"
         FROM authz.group_role_mappings m
         JOIN authz.ad_groups g ON g.id = m.ad_group_id
         JOIN authz.roles r ON r.id = m.role_id
         WHERE g.group_object_id = ANY($1::uuid[])
           AND g.is_active = TRUE
           AND r.is_active = TRUE;`,
        [groupObjectIds],
      );

      return rows.map((row) => row.roleName);
    },
  };
}

module.exports = {
  createDb,
};
