import { Injectable, Logger } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { AxiosError } from "axios";
import { setTimeout } from "timers/promises";
import { catchError, firstValueFrom } from "rxjs";
import { utils } from "zksync-web3";
import { TokenOffChainDataProvider, ITokenOffChainData } from "../../tokenOffChainDataProvider.abstract";

const API_NUMBER_OF_TOKENS_PER_REQUEST = 250;
const API_INITIAL_RETRY_TIMEOUT = 5000;
const API_RETRY_ATTEMPTS = 5;

interface ITokenListItemProviderResponse {
  id: string;
  platforms: Record<string, string>;
}

interface ITokenMarketDataProviderResponse {
  id: string;
  image?: string;
  current_price?: number;
  market_cap?: number;
}

class ProviderResponseError extends Error {
  constructor(message: string, public readonly status: number, public readonly rateLimitResetDate?: Date) {
    super(message);
  }
}

@Injectable()
export class CoingeckoTokenOffChainDataProvider implements TokenOffChainDataProvider {
  private readonly logger: Logger;
  private readonly isProPlan: boolean;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly platformIds: Array<string>;
  constructor(configService: ConfigService, private readonly httpService: HttpService) {
    this.logger = new Logger(CoingeckoTokenOffChainDataProvider.name);
    this.isProPlan = configService.get<boolean>("tokens.coingecko.isProPlan");
    this.apiKey = configService.get<string>("tokens.coingecko.apiKey");
    this.apiUrl = this.isProPlan ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
    const _platformIds = configService.get<Array<string>>("tokens.coingecko.platformIds");
    if (_platformIds[0] === "") {
      this.platformIds = [];
    } else {
      this.platformIds = _platformIds;
    }
  }

  public async getTokensOffChainData({
    bridgedTokensToInclude,
  }: {
    bridgedTokensToInclude: string[];
  }): Promise<ITokenOffChainData[]> {
    const tokensList = await this.getTokensList();
    // Include ETH, all zksync L2 tokens and bridged tokens
    const supportedTokens = tokensList.filter(
      (token) =>
        token.id === "ethereum" ||
        token.platforms.zklinkNova || // unless the nova token is list on coingecko, this will not take effect here
        bridgedTokensToInclude.find(
          (bridgetTokenAddress) =>
            bridgetTokenAddress === token.platforms.ethereum ||
            bridgetTokenAddress === token.platforms.zksync ||
            bridgetTokenAddress === token.platforms.arbitrum ||
            bridgetTokenAddress === token.platforms.optimism ||
            bridgetTokenAddress === token.platforms.mantaPacific ||
            bridgetTokenAddress === token.platforms.mantle ||
            bridgetTokenAddress === token.platforms.linea ||
            bridgetTokenAddress === token.platforms.scroll ||
            bridgetTokenAddress === token.platforms.polygonZkevm ||
            bridgetTokenAddress === token.platforms.starknet
        )
    );

    const tokensOffChainData: ITokenOffChainData[] = [];
    let tokenIdsPerRequest = [];
    for (let i = 0; i < supportedTokens.length; i++) {
      tokenIdsPerRequest.push(supportedTokens[i].id);
      if (tokenIdsPerRequest.length === API_NUMBER_OF_TOKENS_PER_REQUEST || i === supportedTokens.length - 1) {
        const tokensMarkedData = await this.getTokensMarketData(tokenIdsPerRequest);

        for (let tokenMarketData of tokensMarkedData) {
          const token = supportedTokens.find((t) => t.id === tokenMarketData.id);
          for (const platform of this.platformIds) {
            if (token.platforms[platform]) {
              tokensOffChainData.push({
                l1Address: token.platforms[platform],
                l2Address: token.platforms.zklinkNova, // unless the nova token is list on coingecko, this will not take effect here
                liquidity: tokenMarketData.market_cap,
                usdPrice: tokenMarketData.current_price,
                iconURL: tokenMarketData.image,
              });
            }
          }
          if (token.id === "ethereum") {
            tokensOffChainData.push({
              l1Address: utils.ETH_ADDRESS,
              l2Address: null,
              liquidity: tokenMarketData.market_cap,
              usdPrice: tokenMarketData.current_price,
              iconURL: tokenMarketData.image,
            });
          }
        }
        tokenIdsPerRequest = [];
      }
    }
    return tokensOffChainData;
  }

  private getTokensMarketData(tokenIds: string[]) {
    return this.makeApiRequestRetryable<ITokenMarketDataProviderResponse[]>({
      path: "/coins/markets",
      query: {
        vs_currency: "usd",
        ids: tokenIds.join(","),
        per_page: tokenIds.length.toString(),
        page: "1",
        locale: "en",
      },
    });
  }

  private async getTokensList() {
    const list = await this.makeApiRequestRetryable<ITokenListItemProviderResponse[]>({
      path: "/coins/list",
      query: {
        include_platform: "true",
      },
    });
    if (!list) {
      return [];
    }
    return list
      .filter(
        (item) =>
          item.id === "ethereum" ||
          item.platforms.zksync ||
          item.platforms.ethereum ||
          item.platforms["zklink-nova"] ||
          item.platforms["arbitrum-one"] ||
          item.platforms.optimism ||
          item.platforms["manta-pacific"] ||
          item.platforms.mantle ||
          item.platforms.linea ||
          item.platforms.scroll ||
          item.platforms["polygon-zkevm"] ||
          item.platforms.starknet
      )
      .map((item) => ({
        ...item,
        platforms: {
          // use substring(0, 42) to fix some instances when after address there is some additional text
          zklinkNova: item.platforms["zklink-nova"]?.substring(0, 42), // unless the nova token is list on coingecko, this will not take effect here
          zksync: item.platforms.zksync?.substring(0, 42),
          ethereum: item.platforms.ethereum?.substring(0, 42),
          arbitrum: item.platforms["arbitrum-one"]?.substring(0, 42),
          optimism: item.platforms.optimism?.substring(0, 42), // not support yet
          mantaPacific: item.platforms["manta-pacific"]?.substring(0, 42),
          mantle: item.platforms.mantle?.substring(0, 42),
          linea: item.platforms.linea?.substring(0, 42),
          scroll: item.platforms.scroll?.substring(0, 42), // not support yet
          polygonZkevm: item.platforms["polygon-zkevm"]?.substring(0, 42), // not support yet
          starknet: item.platforms.starknet?.substring(0, 66), // not support yet
        },
      }));
  }

  private async makeApiRequestRetryable<T>({
    path,
    query,
    retryAttempt = 0,
    retryTimeout = API_INITIAL_RETRY_TIMEOUT,
  }: {
    path: string;
    query?: Record<string, string>;
    retryAttempt?: number;
    retryTimeout?: number;
  }): Promise<T> {
    try {
      return await this.makeApiRequest<T>(path, query);
    } catch (err) {
      if (err.status === 404) {
        return null;
      }
      if (err.status === 429) {
        const rateLimitResetIn = err.rateLimitResetDate.getTime() - new Date().getTime();
        await setTimeout(rateLimitResetIn >= 0 ? rateLimitResetIn + 1000 : 0);
        return this.makeApiRequestRetryable<T>({
          path,
          query,
        });
      }
      if (retryAttempt >= API_RETRY_ATTEMPTS) {
        this.logger.error({
          message: `Failed to fetch data at ${path} from coingecko after ${retryAttempt} retries`,
          provider: CoingeckoTokenOffChainDataProvider.name,
        });
        return null;
      }
      await setTimeout(retryTimeout);
      return this.makeApiRequestRetryable<T>({
        path,
        query,
        retryAttempt: retryAttempt + 1,
        retryTimeout: retryTimeout * 2,
      });
    }
  }

  private async makeApiRequest<T>(path: string, query?: Record<string, string>): Promise<T> {
    const queryString = new URLSearchParams({
      ...query,
      ...(this.isProPlan
        ? {
            x_cg_pro_api_key: this.apiKey,
          }
        : {
            x_cg_demo_api_key: this.apiKey,
          }),
    }).toString();

    const { data } = await firstValueFrom<{ data: T }>(
      this.httpService.get(`${this.apiUrl}${path}?${queryString}`).pipe(
        catchError((error: AxiosError) => {
          if (error.response?.status === 429) {
            const rateLimitReset = error.response.headers["x-ratelimit-reset"];
            // use specified reset date or 60 seconds by default
            const rateLimitResetDate = rateLimitReset
              ? new Date(rateLimitReset)
              : new Date(new Date().getTime() + 60000);
            this.logger.debug({
              message: `Reached coingecko rate limit, reset at ${rateLimitResetDate}`,
              stack: error.stack,
              status: error.response.status,
              response: error.response.data,
              provider: CoingeckoTokenOffChainDataProvider.name,
            });
            throw new ProviderResponseError(error.message, error.response.status, rateLimitResetDate);
          }
          this.logger.error({
            message: `Failed to fetch data at ${path} from coingecko`,
            stack: error.stack,
            status: error.response?.status,
            response: error.response?.data,
            provider: CoingeckoTokenOffChainDataProvider.name,
          });
          throw new ProviderResponseError(error.message, error.response?.status);
        })
      )
    );
    return data;
  }
}
