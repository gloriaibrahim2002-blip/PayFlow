import { Server } from "@stellar/stellar-sdk/rpc";

/**
 * Interface that mirrors the public API of `@stellar/stellar-sdk/rpc`'s `Server`.
 * By using TypeScript's interface extension and declaration merging, we ensure
 * MultiEndpointServer is fully type-compatible with Server.
 */
export interface MultiEndpointServer extends Server {}

/**
 * Representation of an individual RPC endpoint with error rate tracking and health state.
 */
interface RPCEndpoint {
  url: string;
  errorCount: number;
  healthy: boolean;
}

/**
 * A resilient, drop-in replacement wrapper for `@stellar/stellar-sdk/rpc`'s `Server`.
 * It manages an ordered list of RPC endpoints with automatic, transparent failover,
 * health status monitoring, and network passphrase validation.
 */
export class MultiEndpointServer {
  private endpoints: RPCEndpoint[] = [];
  private currentUrlIndex = 0;
  private serverInstances: Record<string, Server> = {};
  private validatedEndpoints = new Set<string>();
  private serverOpts?: Server.Options;

  /**
   * Constructs a new MultiEndpointServer.
   *
   * @param urlOrUrls An optional single URL, an array of URLs, or comma-separated list of URLs.
   *                  If not provided, the configuration falls back to the `RPC_URLS` environment
   *                  variable, and subsequently to `RPC_URL` or `VITE_RPC_URL`.
   * @param opts Optional Server options passed directly to underlying Server instances.
   */
  constructor(urlOrUrls?: string | string[], opts?: Server.Options) {
    this.serverOpts = opts;
    let urls: string[] = [];

    // 1. Read from RPC_URLS environment variable if defined
    if (process.env.RPC_URLS) {
      urls = process.env.RPC_URLS.split(",")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);
    }

    // 2. If no URLs from env, use constructor argument if provided
    if (urls.length === 0 && urlOrUrls) {
      if (Array.isArray(urlOrUrls)) {
        urls = urlOrUrls;
      } else {
        // Handle comma-separated single string just in case
        urls = urlOrUrls.split(",")
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
      }
    }

    // 3. Fallbacks if still empty
    if (urls.length === 0) {
      const fallback = process.env.RPC_URL || process.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org";
      urls = [fallback];
    }

    // Initialize endpoints list
    this.endpoints = urls.map((url) => ({
      url,
      errorCount: 0,
      healthy: true,
    }));

    // Return a Proxy wrapping this instance to dynamically forward all calls.
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        // If the property exists on MultiEndpointServer itself, return it.
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return value.bind(target);
          }
          return value;
        }

        // Retrieve the standard Server property/method.
        const server = target.getActiveServer();
        const serverProp = Reflect.get(server, prop);

        if (typeof serverProp === "function") {
          return async (...args: any[]) => {
            return target.executeWithFailover(prop as string, args);
          };
        }

        return serverProp;
      },
    }) as any;
  }

  /**
   * Retrieves the currently active Server instance.
   * Lazily instantiates the Server for the active endpoint on demand.
   *
   * @returns A standard `@stellar/stellar-sdk/rpc` Server instance.
   */
  private getActiveServer(): Server {
    const endpoint = this.endpoints[this.currentUrlIndex];
    if (!endpoint) {
      throw new Error("No RPC endpoints configured or available");
    }
    if (!this.serverInstances[endpoint.url]) {
      this.serverInstances[endpoint.url] = new Server(endpoint.url, this.serverOpts);
    }
    return this.serverInstances[endpoint.url];
  }

  /**
   * Validates that the active endpoint matches the expected network passphrase.
   * Performs validation only on first use of the endpoint.
   */
  private async ensureNetworkPassphraseValidation(): Promise<void> {
    const endpoint = this.endpoints[this.currentUrlIndex];
    if (!endpoint) return;

    if (this.validatedEndpoints.has(endpoint.url)) {
      return;
    }

    try {
      const server = this.getActiveServer();
      const networkInfo = await server.getNetwork();
      const expectedPassphrase =
        process.env.NETWORK_PASSPHRASE ||
        process.env.VITE_NETWORK_PASSPHRASE ||
        (process.env.NETWORK === "mainnet"
          ? "Public Global Stellar Network ; October 2015"
          : "Test SDF Network ; September 2015");

      if (networkInfo.passphrase !== expectedPassphrase) {
        throw new Error(
          `Expected network passphrase "${expectedPassphrase}", but endpoint returned "${networkInfo.passphrase}"`
        );
      }

      this.validatedEndpoints.add(endpoint.url);
    } catch (error: any) {
      throw new Error(`Passphrase validation failed for ${endpoint.url}: ${error.message}`);
    }
  }

  /**
   * Demotes a failing endpoint's priority by moving it back in priority order.
   * Endpoints are sorted with healthy ones first, and then by lower error count.
   *
   * @param url The URL of the failing endpoint.
   */
  private demoteEndpoint(url: string): void {
    const endpoint = this.endpoints.find((e) => e.url === url);
    if (endpoint) {
      // Sort criteria: healthy first, then lower error count first.
      this.endpoints.sort((a, b) => {
        if (a.healthy !== b.healthy) {
          return a.healthy ? -1 : 1;
        }
        return a.errorCount - b.errorCount;
      });
    }
  }

  /**
   * Executes a Server method with transparent retry and failover capabilities.
   *
   * @param methodName The name of the Server method to execute.
   * @param args The arguments to pass to the method.
   * @returns The resolved response from the successful RPC call.
   */
  private async executeWithFailover(methodName: string, args: any[]): Promise<any> {
    const attemptedUrls = new Set<string>();

    while (attemptedUrls.size < this.endpoints.length) {
      // Find the highest priority endpoint that hasn't been tried yet during this request
      const endpoint = this.endpoints.find((e) => !attemptedUrls.has(e.url));
      if (!endpoint) {
        throw new Error("All RPC endpoints have been tried and exhausted");
      }

      attemptedUrls.add(endpoint.url);
      this.currentUrlIndex = this.endpoints.indexOf(endpoint);

      try {
        // Validate the endpoint's network passphrase on its first use
        await this.ensureNetworkPassphraseValidation();

        const server = this.getActiveServer();
        const method = (server as any)[methodName];
        if (typeof method !== "function") {
          throw new Error(`Method ${methodName} does not exist on Server`);
        }

        const result = await method.apply(server, args);

        // Reset error state on a successful request
        endpoint.errorCount = 0;
        endpoint.healthy = true;
        return result;
      } catch (error: any) {
        // Increment error count and mark unhealthy if it exceeds the threshold (e.g., 3 failures)
        endpoint.errorCount++;
        if (endpoint.errorCount >= 3) {
          endpoint.healthy = false;
        }

        // Demote priority of the failing endpoint
        this.demoteEndpoint(endpoint.url);

        const reason = error instanceof Error ? error.message : String(error);

        if (attemptedUrls.size < this.endpoints.length) {
          const nextEndpoint = this.endpoints.find((e) => !attemptedUrls.has(e.url));
          const nextUrl = nextEndpoint ? nextEndpoint.url : "none";
          console.warn(`[RPC Failover] Endpoint ${endpoint.url} failed: ${reason}. Retrying with ${nextUrl}...`);
        } else {
          // Exhausted all endpoints, propagate the last error cleanly
          throw error;
        }
      }
    }
  }
}
