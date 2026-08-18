import ApiError from '../utils/ApiError.util.js';
import HTTP_STATUS from '../constants/StatusCodes.constants.js';

class Forbidden extends ApiError {
    constructor(message: string = 'Access Forbidden') {
        super(HTTP_STATUS.FORBIDDEN, message);

        this.message = message;
    }
}

export default Forbidden;
