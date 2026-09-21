export type RoleName = 'admin' | 'operator' | 'client' | 'dealer' | 'technician';

export type AuthUser = {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  sessionId?: string;

  // ✅ siempre será objeto { name } en req.user (por JwtStrategy)
  role?: { name: RoleName };
  
};
