require('dotenv').config()

import * as bitcoin from 'bitcoinjs-lib'
import fetch from 'node-fetch'
import coinselect from 'coinselect'

import * as fs from 'fs'
import * as ecc from 'tiny-secp256k1';

import Big from 'big.js'

import { ECPairFactory } from 'ecpair'
import { Psbt } from 'bitcoinjs-lib'

const [privateKey, to, amount] = process.argv.splice(2)
const rpc = process.env.RPC
const rpcUser = process.env.RPC_USER
const rpcPassword = process.env.RPC_PASSWORD

const basicAuth = Buffer.from(rpcUser + ':' + rpcPassword).toString('base64')


let targets = [{ address: to, value: Number(new Big(amount || 0).mul(10 ** 8).toString()) }]

const fileExists = fs.existsSync('./target.json')

if (fileExists && to) {
	throw new Error(`Please choose single target`)
}

if (!fileExists && !to) {
	throw new Error(`Please set target`)
}

if (fileExists) {
	targets = JSON.parse(fs.readFileSync('./target.json').toString()).map(i => ({
		...i,
		amount: Number(new Big(i.amount || 0).mul(10 ** 8).toString())
	}))
}

const keyPair = ECPairFactory(ecc).fromWIF(privateKey, bitcoin.networks.regtest)
const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: bitcoin.networks.regtest })

console.log(`[Address]: ${address}`)

async function bootstrap() {
	const result = await fetch(rpc, {
		method: 'post',
		headers: {
			'content-type': 'application/json',
			authorization: `Basic ${basicAuth}`,
		},
		body: JSON.stringify({
			jsonrpc: '1.0',
			id: 'curltest',
			method: 'scantxoutset',
			params: ['start', [`addr(${address})`]],
		}),
	}).catch(e => {
		console.error(e)
		return null
	})

	const {
		result: { unspents, total_amount },
	} = await result.json()

	console.log('[Unspent]: ' + unspents.length + '. Total: ' + total_amount + ' BTC')

	const utxos = await Promise.all(
		unspents.map(async i => {
			const txResult = await fetch(rpc, {
				method: 'post',
				headers: {
					'content-type': 'application/json',
					authorization: `Basic ${basicAuth}`,
				},
				body: JSON.stringify({
					jsonrpc: '1.0',
					id: 'curltest',
					method: 'getrawtransaction',
					params: [i.txid],
				}),
			}).catch(e => {
				console.error(e)
				return null
			})

			const { result: rawTx } = await txResult.json()

			return {
				txId: i.txid,
				value: Number(new Big(i.amount).mul(10 ** 8).toString()),
				nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
				vout: i.vout,
			}
		})
	)

	const { inputs, outputs } = coinselect(utxos, targets, 50)

	console.log({ inputs, outputs })

	if (!inputs || !outputs) {
		console.error('Cannot build transaction')
		return
	}

	const psbt = new Psbt({ network: bitcoin.networks.regtest }).setVersion(2).setLocktime(0)

	inputs.forEach(input => {
		psbt.addInput({
			hash: input.txId,
			index: input.vout,
			nonWitnessUtxo: input.nonWitnessUtxo,
		})
	})

	outputs.forEach(output => {
		if (!output.address) {
			output.address = address
		}
		psbt.addOutput({
			address: output.address,
			value: output.value,
		})
	})

	psbt.signAllInputs(keyPair).finalizeAllInputs()

	const txHex = psbt.extractTransaction().toHex()

	const pushResult = await fetch(rpc, {
		method: 'post',
		body: JSON.stringify({
			jsonrpc: '1.0',
			id: 'curltest',
			method: 'sendrawtransaction',
			params: [txHex],
		}),
		headers: {
			'content-type': 'application/json',
			authorization: `Basic ${basicAuth}`,
		},
	}).catch(e => {
		console.error(e)
		return null
	})

	const { result: push } = await pushResult.json()

	console.log(`[RESULT]: ${push}`)
}

bootstrap()
