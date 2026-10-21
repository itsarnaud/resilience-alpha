"""Verify operator/dashboard JWTs issued by the team's auth service."""

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt.exceptions import PyJWKClientConnectionError


def verify_operator_token(
    token: str,
    public_key,
    issuer: str,
    audience: str,
) -> dict:
    claims = jwt.decode(
        token,
        public_key,
        algorithms=["RS256"],
        issuer=issuer,
        audience=audience,
        options={"require": ["sub", "exp", "iat", "iss", "aud"]},
    )

    if not isinstance(claims["sub"], str) or not claims["sub"].strip():
        raise jwt.InvalidTokenError("Invalid subject")

    roles = claims.get("roles")
    if not isinstance(roles, list) or not all(
        isinstance(role, str) for role in roles
    ):
        raise jwt.InvalidTokenError("Invalid roles")

    if not {"operator", "svc:dashboard"}.intersection(roles):
        raise PermissionError("Operator or dashboard role required")

    return claims


def operator_dependency(jwks_url: str, issuer: str, audience: str):
    """Create a reusable FastAPI dependency with cached JWKS retrieval."""
    if not all((jwks_url, issuer, audience)):
        raise ValueError("JWKS URL, issuer and audience are required")

    keys = jwt.PyJWKClient(jwks_url, timeout=5)
    bearer = HTTPBearer(auto_error=False)

    def require_operator(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> dict:
        if credentials is None:
            raise HTTPException(
                status_code=401,
                detail="Bearer token required",
                headers={"WWW-Authenticate": "Bearer"},
            )

        try:
            key = keys.get_signing_key_from_jwt(credentials.credentials)
            return verify_operator_token(
                credentials.credentials, key.key, issuer, audience
            )
        except PyJWKClientConnectionError:
            raise HTTPException(
                status_code=503,
                detail="Authentication key service unavailable",
            ) from None
        except PermissionError:
            raise HTTPException(status_code=403, detail="Insufficient role") from None
        except jwt.PyJWTError:
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired token",
                headers={"WWW-Authenticate": "Bearer"},
            ) from None

    return require_operator
