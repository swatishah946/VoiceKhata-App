import pool from '../db';

/**
 * Members: the people who can log in to the app, and which business they belong to.
 */
export interface Member {
  organizationId: string;
  phone: string;
  name: string | null;
  role: 'owner' | 'staff';
}

export async function addMember(orgId: string, phone: string, name: string | null, role: 'owner' | 'staff') {
  await pool.query(
    `INSERT INTO organization_members (phone, organization_id, name, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone) DO UPDATE SET organization_id = EXCLUDED.organization_id, name = EXCLUDED.name,
       role = EXCLUDED.role, is_active = TRUE`,
    [phone, orgId, name, role]
  );
}
