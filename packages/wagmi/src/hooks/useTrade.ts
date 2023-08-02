import {
  findMultiRouteExactIn,
  findSingleRouteExactIn,
  SushiSwapV2Pool,
  Trade,
  TradeType,
  TridentConstantPool,
  Version as TradeVersion,
} from '@sushiswap/amm'
import { BentoBoxV1ChainId, isBentoBoxV1ChainId } from '@sushiswap/bentobox'
import { ChainId, chainName } from '@sushiswap/chain'
import { Amount, Type as Currency, WNATIVE } from '@sushiswap/currency'
import { RouteStatus } from '@sushiswap/tines'
import { isSushiSwapV2ChainId, SUSHISWAP_V2_FACTORY_ADDRESS, SushiSwapV2ChainId } from '@sushiswap/v2-sdk'
import { useMemo } from 'react'
import { useFeeData } from 'wagmi'

import { useBentoBoxTotals } from './useBentoBoxTotals'
import { getConstantProductPoolFactoryContract } from './useConstantProductPoolFactoryContract'
import { ConstantProductPoolState, useGetConstantProductPools } from './useConstantProductPools'
import { useCurrencyCombinations } from './useCurrencyCombinations'
import { PairState, usePairs } from './usePairs'

type UseTradePayload = {
  chainId: ChainId
  tradeType: TradeType.EXACT_INPUT | TradeType.EXACT_OUTPUT
  amountSpecified: Amount<Currency> | undefined
  mainCurrency: Currency | undefined
  otherCurrency: Currency | undefined
  tridentEnabled?: boolean
  ammEnabled?: boolean
}

export type TradeOutput =
  | Trade<Currency, Currency, TradeType.EXACT_INPUT | TradeType.EXACT_OUTPUT, TradeVersion.V1 | TradeVersion.V2>
  | undefined

export interface UseTradeOutput {
  data: TradeOutput
  isLoading: boolean
  isError: boolean
}

type UseTrade = (payload: UseTradePayload) => UseTradeOutput

/**
 * Returns trade for a desired swap.
 * @param chainId
 * @param tradeType whether we request an exact output amount or we provide an exact input amount
 * @param amountSpecified the exact amount to swap in/out
 * @param mainCurrency the desired input/payment currency
 * @param otherCurrency the desired output/payment currency
 * @param tridentEnabled whether to fetch trident pools
 * @param ammEnabled whether to fetch amm pools
 */
export const useTrade: UseTrade = ({
  chainId,
  tradeType,
  amountSpecified,
  mainCurrency,
  otherCurrency,
  tridentEnabled = true,
  ammEnabled = true,
}) => {
  if (ammEnabled && !isSushiSwapV2ChainId(chainId))
    throw new Error(`ChainId Error: SushiSwapV2 is not available on ${chainName[chainId]} and ammEnabled is enabled.`)

  // TODO: Use trident chainId instead of Bento
  if (tridentEnabled && !isBentoBoxV1ChainId(chainId))
    throw new Error(`ChainId Error: BentoBox is not available on ${chainName[chainId]} and tridentEnabled is enabled.`)

  const { data } = useFeeData({
    chainId,
  })

  const currencies = useMemo(
    () => (tradeType === TradeType.EXACT_INPUT ? [mainCurrency, otherCurrency] : [otherCurrency, mainCurrency]),
    [tradeType, mainCurrency, otherCurrency]
  )

  const [currencyIn, currencyOut] = currencies

  // Generate currency combinations of input and output token based on configured bases
  const currencyCombinations = useCurrencyCombinations(chainId, currencyIn, currencyOut)

  // Legacy SushiSwap pairs
  const {
    data: pairs,
    isLoading: isPairsLoading,
    isError: isPairsError,
  } = usePairs(chainId as SushiSwapV2ChainId, currencyCombinations, { enabled: ammEnabled })

  // Trident constant product pools
  const {
    data: constantProductPools,
    isLoading: isCppLoading,
    isError: isCppError,
  } = useGetConstantProductPools(chainId, currencyCombinations, {
    enabled: tridentEnabled,
  })

  // Combined legacy and trident pools
  const pools = useMemo(() => [...pairs, ...constantProductPools], [pairs, constantProductPools])

  // Filter legacy and trident pools by existance
  const filteredPools = useMemo(
    () =>
      Object.values(
        pools
          // filter out invalid pools
          .filter(
            (
              result
            ): result is [PairState.EXISTS, SushiSwapV2Pool] | [ConstantProductPoolState.EXISTS, TridentConstantPool] =>
              Boolean(result[0] === PairState.EXISTS && result[1]) ||
              Boolean(result[0] === ConstantProductPoolState.EXISTS && result[1])
          )
          .map(([, pair]) => pair)
      ),
    [pools]
  )

  const rebases = useBentoBoxTotals(chainId as BentoBoxV1ChainId, currencies)
  const currencyInRebase = currencyIn ? rebases?.[currencyIn.wrapped.address] : undefined
  const currencyOutRebase = currencyOut ? rebases?.[currencyOut.wrapped.address] : undefined

  return useMemo(() => {
    if (
      data?.gasPrice &&
      currencyIn &&
      currencyInRebase &&
      currencyOut &&
      currencyOutRebase &&
      currencyIn.wrapped.address !== currencyOut.wrapped.address &&
      chainId &&
      amountSpecified &&
      amountSpecified.greaterThan(0) &&
      otherCurrency &&
      filteredPools.length > 0
    ) {
      if (tradeType === TradeType.EXACT_INPUT) {
        if (chainId in SUSHISWAP_V2_FACTORY_ADDRESS && getConstantProductPoolFactoryContract(chainId).address) {
          const legacyRoute = findSingleRouteExactIn(
            currencyIn.wrapped,
            currencyOut.wrapped,
            amountSpecified.quotient,
            filteredPools.filter((pool): pool is SushiSwapV2Pool => pool instanceof SushiSwapV2Pool),
            WNATIVE[amountSpecified.currency.chainId],
            Number(data.gasPrice)
          )

          const tridentRoute = findMultiRouteExactIn(
            currencyIn.wrapped,
            currencyOut.wrapped,
            amountSpecified.toShare(currencyInRebase).quotient,
            filteredPools.filter((pool): pool is TridentConstantPool => pool instanceof TridentConstantPool),
            WNATIVE[amountSpecified.currency.chainId],
            Number(data.gasPrice)
          )

          const useLegacy = Amount.fromRawAmount(currencyOut.wrapped, legacyRoute.amountOutBN.toString()).greaterThan(
            Amount.fromShare(currencyOut.wrapped, tridentRoute.amountOutBN.toString(), currencyOutRebase)
          )

          return {
            data: Trade.exactIn(
              useLegacy ? legacyRoute : tridentRoute,
              amountSpecified,
              currencyOut,
              useLegacy ? TradeVersion.V1 : TradeVersion.V2,
              !useLegacy ? currencyInRebase : undefined,
              !useLegacy ? currencyOutRebase : undefined
            ),
            isLoading: isPairsLoading || isCppLoading,
            isError: isPairsError || isCppError,
          }
        }

        const legacyRoute = findSingleRouteExactIn(
          currencyIn.wrapped,
          currencyOut.wrapped,
          amountSpecified.quotient,
          filteredPools.filter((pool): pool is TridentConstantPool => pool instanceof SushiSwapV2Pool),
          WNATIVE[amountSpecified.currency.chainId],
          Number(data.gasPrice)
        )

        if (legacyRoute.status === RouteStatus.Success) {
          // console.debug('Found legacy route', legacyRoute)
          return {
            data: Trade.exactIn(legacyRoute, amountSpecified, currencyOut, TradeVersion.V1),
            isLoading: isPairsLoading || isCppLoading,
            isError: isPairsError || isCppError,
          }
        } else {
          // console.debug('No legacy route', legacyRoute)
        }

        // TODO: Switch to shares
        const tridentRoute = findMultiRouteExactIn(
          currencyIn.wrapped,
          currencyOut.wrapped,
          amountSpecified.toShare(currencyInRebase).quotient,
          filteredPools.filter((pool): pool is TridentConstantPool => pool instanceof TridentConstantPool),
          WNATIVE[amountSpecified.currency.chainId],
          Number(data.gasPrice)
        )
        if (tridentRoute.status === RouteStatus.Success) {
          return {
            data: Trade.exactIn(
              tridentRoute,
              amountSpecified,
              currencyOut,
              TradeVersion.V2,
              currencyInRebase,
              currencyOutRebase
            ),
            isLoading: isPairsLoading || isCppLoading,
            isError: isPairsError || isCppError,
          }
        }

        // TODO: Use best trade if both available
      } else if (tradeType === TradeType.EXACT_OUTPUT) {
        //
      }
    }

    return {
      data: undefined,
      isLoading: false,
      isError: false,
    }
  }, [
    data,
    currencyIn,
    currencyInRebase,
    currencyOut,
    currencyOutRebase,
    chainId,
    amountSpecified,
    otherCurrency,
    filteredPools,
    tradeType,
    isPairsLoading,
    isCppLoading,
    isPairsError,
    isCppError,
  ])
}
