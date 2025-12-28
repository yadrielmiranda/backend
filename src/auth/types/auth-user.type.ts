export type RoleName = 'admin' | 'operator' | 'client' | 'dealer';

export type AuthUser = {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;

  // ✅ siempre será objeto { name } en req.user (por JwtStrategy)
  role?: { name: RoleName };
  
};
