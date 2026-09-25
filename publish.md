# How to create a new release

## Build and Test Locally

```bash
npm install --legacy-peer-deps
npm test -- --runInBand
npm run build:lib
npm pack ./src
```

The existing development app uses React Scripts 5 with TypeScript 5, requiring
legacy peer resolution for npm installs. `build:lib` builds the distributable
package independently from that app. The frontend consumes a versioned tarball;
its `vendor/README.md` describes the workspace packaging commands.

## ID-Token Requests

`AuthContext.getIdTokenSilently()` returns a raw ID token with more than 30 seconds
remaining, refreshing independently of access-token expiry. `getTokenSilently()`
continues to return an access token. Both share a refresh lock and recheck storage
inside the lock; matching in-flight requests share a promise. Local-storage
refresh additionally requires Web Locks for cross-tab refresh-token rotation.
Without Web Locks, callers receive `AuthenticationRequiredError` when refresh is
needed. Session-storage refresh uses the in-page lock.

`AuthenticationRequiredError` means login is needed (missing/expired/revoked
refresh token, or no usable ID token after refresh). Network/server failures
reject without clearing the session and should not cause automatic login loops.
Calling `logIn()` while login is already in progress is a no-op. Logout discards
in-flight refresh results. Omitted refresh tokens retain the previous token and
absolute expiry. Omitted ID tokens are retained only while still usable.

Token exchanges and refreshes have a 30-second deadline, including response-body
consumption. A deadline aborts the fetch and rejects with a `TimeoutError`
(`DOMException`), releases the refresh locks, and leaves stored credentials intact.
Late responses are ignored and timers are cleared on success or failure. Timeout
does not mean `AuthenticationRequiredError`; there is no automatic retry. The
provider may have processed a timed-out refresh and rotated its token, so a later
caller retry can still receive `invalid_grant` and require authentication. The
deadline begins when the request starts, not while waiting to acquire a lock.

The identity provider must issue ID tokens on login and refresh with an `exp`
claim. Expiry decoding is for scheduling only; the resource server must validate
signature, issuer, audience and required claims. ID-token acceptance must be an
explicit contract with that API. Test with the target provider before release.

## Publish

```bash
# Bump version in './src/package.json'
git commit -m "bump version"
git tag v?.?.? -m "A Message"
git push --tags
```
