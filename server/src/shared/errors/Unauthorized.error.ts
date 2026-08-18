import ApiError from '../utils/ApiError.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

class Unauthorized extends ApiError {
    constructor(message: string = 'Unauthorized Access') {
        super(HTTP_STATUS.UNAUTHORIZED, message);

        this.message = message;
    }
}

export default Unauthorized;
