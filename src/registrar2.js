import {
  getENSContract,
  getResolverContract,
  getPermanentRegistrarContract,
  getPermanentRegistrarControllerContract,
  getLegacyAuctionContract,
  getDeedContract
} from './contracts'

import {
  getAccount,
  getBlock,
  getProvider,
  getSigner,
  getNetworkId
} from './web3'

import namehash from './utils/namehash'

import { interfaces } from './constants/interfaces'
import { isEncodedLabelhash, labelhash } from './utils/labelhash'

const {
  legacyRegistrar: legacyRegistrarInterfaceId,
  permanentRegistrar: permanentRegistrarInterfaceId
} = interfaces

export default class Registrar {
  constructor({
    registryAddress,
    ethAddress,
    legacyAuctionRegistrarAddress,
    provider
  }) {
    const permanentRegistrar = getPermanentRegistrarContract({
      address: ethAddr,
      provider
    })
    const permanentRegistrarController = getPermanentRegistrarControllerContract(
      { address: ethAddress, provider }
    )
    const legacyAuctionRegistrar = getLegacyAuctionContract({
      address: legacyAuctionRegistrarAddress,
      provider
    })

    const ENS = getENSContract({ address: registryAddress, provider })

    this.permanentRegistrar = permanentRegistrar
    this.permanentRegistrarController = permanentRegistrarController
    this.legacyAuctionRegistrar = legacyAuctionRegistrar
    this.registryAddress = registryAddress
    this.ENS = ENS
  }

  async getAddress(name) {
    const provider = await getProvider()
    const hash = namehash(name)
    const resolverAddr = await this.ENS.resolver(hash)
    const Resolver = getResolverContract({ address: resolverAddr, provider })
    return Resolver['addr(bytes32)'](hash)
  }

  async getDeed(address) {
    const provider = await getProvider()
    return getDeedContract({ address, provider })
  }

  async getLegacyEntry(label) {
    let legacyEntry
    try {
      const Registrar = this.legacyAuctionRegistrar
      let deedOwner = '0x0'
      const entry = await Registrar.entries(labelhash(label))
      if (parseInt(entry[1], 16) !== 0) {
        const deed = await getDeed(entry[1])
        deedOwner = await deed.owner()
      }
      legacyEntry = {
        deedOwner, // TODO: Display "Release" button if deedOwner is not 0x0
        state: parseInt(entry[0]),
        registrationDate: parseInt(entry[2]) * 1000,
        revealDate: (parseInt(entry[2]) - 24 * 2 * 60 * 60) * 1000,
        value: parseInt(entry[3]),
        highestBid: parseInt(entry[4])
      }
    } catch (e) {
      legacyEntry = {
        deedOwner: '0x0',
        state: 0,
        registrationDate: 0,
        revealDate: 0,
        value: 0,
        highestBid: 0,
        expiryTime: 0,
        error: e.message
      }
    }
    return legacyEntry
  }

  async getPermanentEntry(label) {
    const {
      permanentRegistrar: Registrar,
      permanentRegistrarController: RegistrarController
    } = this
    let getAvailable
    let ret = {
      available: null,
      nameExpires: null
    }
    try {
      const labelHash = labelhash(label)

      // Returns true if name is available
      if (isEncodedLabelhash(label)) {
        getAvailable = Registrar.available(labelHash)
      } else {
        getAvailable = RegistrarController.available(label)
      }

      const [available, nameExpires, gracePeriod] = await Promise.all([
        getAvailable,
        Registrar.nameExpires(labelHash),
        getGracePeriod(Registrar)
      ])

      ret = {
        ...ret,
        available,
        gracePeriod,
        nameExpires: nameExpires > 0 ? new Date(nameExpires * 1000) : null
      }
      // Returns registrar address if owned by new registrar.
      // Keep it as a separate call as this will throw exception for non existing domains
      ret.ownerOf = await Registrar.ownerOf(labelHash)
    } catch (e) {
      console.log('Error getting permanent registrar entry', e)
      return false
    } finally {
      return ret
    }
  }

  async getEntry(label) {
    let [block, legacyEntry, permEntry] = await Promise.all([
      getBlock(),
      this.getLegacyEntry(label),
      this.getPermanentEntry(label)
    ])

    let ret = {
      currentBlockDate: new Date(block.timestamp * 1000),
      registrant: 0,
      transferEndDate: null,
      isNewRegistrar: false,
      gracePeriodEndDate: null
    }

    if (permEntry) {
      ret.available = permEntry.available
      if (permEntry.nameExpires) {
        ret.expiryTime = permEntry.nameExpires
      }
      if (permEntry.ownerOf) {
        ret.registrant = permEntry.ownerOf
        ret.isNewRegistrar = true
      } else if (permEntry.nameExpires) {
        const currentTime = new Date(ret.currentBlockDate)
        const gracePeriodEndDate = new Date(
          currentTime.getTime() + permEntry.gracePeriod * 1000
        )
        // It is within grace period
        if (permEntry.nameExpires < currentTime < gracePeriodEndDate) {
          ret.isNewRegistrar = true
          ret.gracePeriodEndDate = gracePeriodEndDate
        }
      }
    }

    return {
      ...legacyEntry,
      ...ret
    }
  }

  async transferOwner(name, to, overrides = {}) {
    try {
      const nameArray = name.split('.')
      const labelHash = labelhash(nameArray[0])
      const account = await getAccount()
      const permanentRegistrar = this.permanentRegistrar
      const signer = await getSigner()
      const Registrar = permanentRegistrar.connect(signer)
      const networkId = await getNetworkId()
      if (parseInt(networkId) > 1000) {
        /* if private network */
        const gas = await Registrar.estimate.safeTransferFrom(
          account,
          to,
          labelHash
        )

        overrides = {
          ...overrides,
          gasLimit: gas.toNumber() * 2
        }
      }
      return Registrar.safeTransferFrom(account, to, labelHash, overrides)
    } catch (e) {
      console.log('Error calling transferOwner', e)
    }
  }

  async reclaim(name, address, overrides = {}) {
    try {
      const nameArray = name.split('.')
      const labelHash = labelhash(nameArray[0])
      const permanentRegistrar = this.permanentRegistrar
      const signer = await getSigner()
      const Registrar = permanentRegistrar.connect(signer)
      const networkId = await getNetworkId()
      if (parseInt(networkId) > 1000) {
        /* if private network */
        const gas = await Registrar.estimate.reclaim(labelHash, address)

        overrides = {
          ...overrides,
          gasLimit: gas.toNumber() * 2
        }
      }

      return Registrar.reclaim(labelHash, address, {
        ...overrides
      })
    } catch (e) {
      console.log('Error calling reclaim', e)
    }
  }

  async getRentPrice(name, duration) {
    const permanentRegistrarController = this.permanentRegistrarController
    return permanentRegistrarController.rentPrice(name, duration)
  }

  async getMinimumCommitmentAge() {
    const permanentRegistrarController = this.permanentRegistrarController
    return permanentRegistrarController.minCommitmentAge()
  }

  async makeCommitment(name, owner, secret = '') {
    const permanentRegistrarControllerWithoutSigner = this
      .permanentRegistrarController
    const signer = await getSigner()
    const permanentRegistrarController = permanentRegistrarControllerWithoutSigner.connect(
      signer
    )
    const account = await getAccount()
    const resolverAddr = await this.getAddress('resolver.eth')
    if (parseInt(resolverAddr, 16) === 0) {
      return permanentRegistrarController.makeCommitment(name, owner, secret)
    } else {
      return permanentRegistrarController.makeCommitmentWithConfig(
        name,
        owner,
        secret,
        resolverAddr,
        account
      )
    }
  }

  async commit(label, secret = '') {
    const permanentRegistrarControllerWithoutSigner = this
      .permanentRegistrarController
    const signer = await getSigner()
    const permanentRegistrarController = permanentRegistrarControllerWithoutSigner.connect(
      signer
    )
    const account = await getAccount()
    const commitment = await makeCommitment(label, account, secret)

    return permanentRegistrarController.commit(commitment)
  }

  async register(label, duration, secret) {
    const permanentRegistrarControllerWithoutSigner = this
      .permanentRegistrarController
    const signer = await getSigner()
    const permanentRegistrarController = permanentRegistrarControllerWithoutSigner.connect(
      signer
    )
    const account = await getAccount()
    const price = await this.getRentPrice(label, duration)
    const resolverAddr = await this.getAddress('resolver.eth')
    if (parseInt(resolverAddr, 16) === 0) {
      return permanentRegistrarController.register(
        label,
        account,
        duration,
        secret,
        { value: price }
      )
    } else {
      return permanentRegistrarController.registerWithConfig(
        label,
        account,
        duration,
        secret,
        resolverAddr,
        account,
        { value: price }
      )
    }
  }

  async renew(label, duration) {
    const permanentRegistrarControllerWithoutSigner = this
      .permanentRegistrarController
    const signer = await getSigner()
    const permanentRegistrarController = permanentRegistrarControllerWithoutSigner.connect(
      signer
    )
    const price = await this.getRentPrice(label, duration)

    return permanentRegistrarController.renew(label, duration, { value: price })
  }

  async releaseDeed(label) {
    const legacyAuctionRegistrar = this.legacyAuctionRegistrar
    const signer = await getSigner()
    const legacyAuctionRegistrarWithSigner = legacyAuctionRegistrar.connect(
      signer
    )
    const hash = labelhash(label)
    return legacyAuctionRegistrarWithSigner.releaseDeed(hash)
  }
}

async function getEthResolver(ENS) {
  const resolverAddr = await ENS.resolver(getNamehash('eth'))
  return getResolverContract(resolverAddr)
}

export async function setupRegistrar(registryAddress) {
  const provider = await getProvider()
  const ENS = getENSContract({ address: registryAddress, provider })
  const Resolver = await getEthResolver(ENS)

  let ethAddress = await ENS.owner(namehash('eth'))

  let controllerAddress = await Resolver.interfaceImplementer(
    namehash('eth'),
    permanentRegistrarInterfaceId
  )
  let legacyAuctionRegistrarAddress = await Resolver.interfaceImplementer(
    namehash('eth'),
    legacyRegistrarInterfaceId
  )

  return new Registrar({
    registryAddress,
    legacyAuctionRegistrarAddress,
    ethAddress,
    controllerAddress,
    provider
  })
}
