
interface AuthenticatedUser {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  role: {
    id: number;
    name: string;
  };
}


declare namespace Express {
  export interface Request {
    user?: AuthenticatedUser;
  }
}