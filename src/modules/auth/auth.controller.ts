import { Request, Response } from 'express';
import * as authService from './auth.service';
import { deleteUserRefreshTokens, storeRefreshToken } from './auth.repository';
import { generateRefreshToken, hashRefreshToken, getMyContexts, getMyPermissions } from './auth.service';
import { signToken } from '../../utils/jwt';

export const login = async (req: Request, res: Response) => {
    const { email, password } = req.body;
    
    if (!email || !password)
        return res.status(400).json({ message: 'Email and Password are required' });
    
    try {
        const result = await authService.login(email, password);
        
        // Also set as httpOnly cookie for refresh endpoint
        res.cookie("refreshToken", result.refreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            path: "/auth/refresh",
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days    
        });

        // Return full response including refreshToken for frontend storage
        return res.status(200).json(result);


    } catch(err) {
        // Log the FULL error server-side. A pg connection/internal error (code XX000,
        // severity FATAL) is NOT a bad-password case — but JSON.stringify drops the
        // Error's non-enumerable .message, so it must be logged here to be seen.
        console.error('[auth.login] error:', err);
        const e = err as any;
        const isCredentialError = e instanceof Error && e.message === 'Invalid Credentials';
        if (isCredentialError) {
            return res.status(401).json({ message: 'Invalid Credentials' });
        }
        // A real failure (DB down, schema, etc.) — surface it as 500 with the message.
        return res.status(500).json({ message: 'Login failed', error: e?.message ?? String(e) });
    }
};

export const logout = async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    await deleteUserRefreshTokens(userId);
    res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/auth/refresh',
    });
    return res.status(200).json({ message: 'Logged out successfully' });
};

export const refreshToken = async(req:Request, res: Response) => {
    const refreshToken = req.cookies.refreshToken;
    if(!refreshToken) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const user = await authService.getUserByRefreshToken(refreshToken);
        if(!user) return res.status(401).json({ message: 'Unauthorized' });
        const newAccessToken = signToken({ userId: user.id });

        const newRefreshToken = generateRefreshToken();
        // Rotate: delete old tokens, store new one
        await deleteUserRefreshTokens(user.id);
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        await storeRefreshToken(user.id, newRefreshToken, expiresAt);

        // Rotate the refresh token
        res.cookie("refreshToken", newRefreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            path: "/auth/refresh", 
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days    
        });
        return res.status(200).json({ 
            token: newAccessToken, 
            refreshToken: newRefreshToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
            }
        });
    } catch {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    
}

export const getContexts = async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const contexts = await getMyContexts(userId);
        return res.json(contexts);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Failed to fetch contexts' });
    }
};

export const getPermissions = async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const orgId = req.headers['x-org-id'] as string;
    const projectId = req.headers['x-project-id'] as string;

    try {
        const permissions = await getMyPermissions(userId, orgId, projectId);
        return res.json({ permissions });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Failed to fetch permissions' });
    }
};
