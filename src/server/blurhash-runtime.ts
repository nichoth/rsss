import { encode } from 'blurhash'
import {
    PhotonImage,
    SamplingFilter,
    resize
} from '@cf-wasm/photon/workerd'
import {
    fetchBlurhashImageBytes,
    type BlurhashConsumerDeps,
    type BlurhashImage
} from './blurhash-consumer.js'

export function createBlurhashConsumerDeps ():BlurhashConsumerDeps {
    return {
        fetchImage (request) {
            return fetchBlurhashImageBytes(request)
        },
        decodeImage (bytes) {
            return PhotonImage.new_from_byteslice(bytes) as BlurhashImage
        },
        resizeImage (image, width, height) {
            return resize(
                image as PhotonImage,
                width,
                height,
                SamplingFilter.Nearest
            ) as BlurhashImage
        },
        encodePixels: encode
    }
}
